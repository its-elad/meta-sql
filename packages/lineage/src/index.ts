import {
  type ColumnLineageDatasetFacet,
  type InputField,
  type Transformation as _Transformation,
  type TransformationType,
  type TransformationSubtype,
} from "@meta-sql/open-lineage";
import {
  Select,
  Column as AstColumn,
  ColumnRefItem,
  BaseFrom,
  Binary,
  ExpressionValue,
  AggrFunc,
  Function as AstFunction,
  With,
  Case,
  Interval,
  Cast,
} from "node-sql-parser";
import { HashSet } from "./hashset";

type Transformation = Exclude<_Transformation, "masking"> & {
  masking: boolean; // output boolean only for easier testing
};

const MASKING_AGG_FUNCTIONS = new Set(["COUNT"]);

const MASKING_FUNCTIONS = new Set([
  "MD5",
  "SHA1",
  "SHA2",
  "SHA256",
  "SHA512",
  "MURMUR3",
  "SPOOKY_HASH_V2_32",
  "SPOOKY_HASH_V2_64",
  "HASH",
  "ANONYMIZE",
  "MASK",
  "REDACT",
]);

// Direct transformation constants
export const DIRECT_TRANSFORMATION: Transformation = {
  type: "DIRECT",
  subtype: "TRANSFORMATION",
  masking: false,
};

export const DIRECT_IDENTITY: Transformation = {
  type: "DIRECT",
  subtype: "IDENTITY",
  masking: false,
};

export const DIRECT_AGGREGATION: Transformation = {
  type: "DIRECT",
  subtype: "AGGREGATION",
  masking: false,
};

// Indirect transformation constants
export const INDIRECT_JOIN: Transformation = {
  type: "INDIRECT",
  subtype: "JOIN",
  masking: false,
};

export const INDIRECT_FILTER: Transformation = {
  type: "INDIRECT",
  subtype: "FILTER",
  masking: false,
};

export const INDIRECT_GROUP_BY: Transformation = {
  type: "INDIRECT",
  subtype: "GROUP_BY",
  masking: false,
};

export const INDIRECT_SORT: Transformation = {
  type: "INDIRECT",
  subtype: "SORT",
  masking: false,
};

export const INDIRECT_WINDOW: Transformation = {
  type: "INDIRECT",
  subtype: "WINDOW",
  masking: false,
};

export const INDIRECT_CONDITION: Transformation = {
  type: "INDIRECT",
  subtype: "CONDITION",
  masking: false,
};

function createTransformation(
  type: TransformationType,
  subtype: TransformationSubtype,
  masking: boolean = false,
): Transformation {
  return { type, subtype, masking };
}

function mergeTransformations(parent: Transformation | undefined, child: Transformation): Transformation {
  if (!parent) {
    return child;
  }

  // If types differ, prefer the more specific one
  // INDIRECT is generally more specific than DIRECT for the same column
  if (parent.type !== child.type) {
    // Keep the child transformation but merge masking
    return { ...child, masking: parent.masking || child.masking };
  }

  if (child.type === "DIRECT" && parent.type === "DIRECT") {
    let leading: Transformation;

    // agg > transformation > identity
    if (parent.subtype === "AGGREGATION") {
      leading = parent;
    } else if (child.subtype === "AGGREGATION") {
      leading = child;
    } else if (parent.subtype === "TRANSFORMATION") {
      leading = parent;
    } else {
      leading = child;
    }

    return { ...leading, masking: parent.masking || child.masking };
  }

  // For INDIRECT transformations, prefer the child (more recent context)
  return { ...child, masking: parent.masking || child.masking };
}

class TransformationSet extends HashSet<Transformation> {
  constructor(values?: readonly Transformation[]) {
    super((value: Transformation) => `${value.type}-${value.subtype}-${value.masking ? "MASKED" : "UNMASKED"}`);

    if (values) {
      values.forEach((value) => this.add(value));
    }
  }
}

export type Column = {
  name: string;
};

export type Table = {
  name: string;
  columns: string[];
};

export type Schema = {
  namespace: string;
  tables: Table[];
};

export type InputColumn = {
  name: string;
  table?: string;
};

export type SelectWithAlias = Select & {
  as?: string | null;
};

/**
 * Extended lineage result that includes both field-level and dataset-level lineage
 */
export interface ExtendedLineageResult {
  fields: ColumnLineageDatasetFacet["fields"];
  dataset?: InputField[];
}

export function isColumn(selectColumn: Select["columns"][number]): selectColumn is AstColumn {
  return (
    typeof selectColumn === "object" &&
    selectColumn !== null &&
    "as" in selectColumn &&
    "expr" in selectColumn &&
    typeof selectColumn.expr === "object" &&
    selectColumn.expr !== null
  );
}

export function formatInputColumnName(column: ColumnRefItem): string {
  return `${column.table ? `${column.table}.` : ""}${getInputColumnName(column)}`;
}

export function parseInputColumnName(column: string): InputColumn {
  const parts = column.split(".");
  const name = parts.pop() || "";
  const table = parts.length > 0 ? parts.join(".") : undefined;

  return { name, table };
}

export function getInputColumnName(column: ColumnRefItem): string | null {
  return typeof column.column === "string"
    ? column.column
    : typeof column.column.expr.value === "string"
      ? column.column.expr.value
      : null;
}

export function getOutputColumnName(column: AstColumn): string | null {
  if (column.as) {
    return typeof column.as === "string" ? column.as : column.as.value;
  } else if (column.expr.type === "column_ref") {
    return getInputColumnName(column.expr as ColumnRefItem);
  }

  return null;
}

/**
 * Extract column references from any expression value
 */
export function extractColumnRefs(expr: ExpressionValue | null | undefined): ColumnRefItem[] {
  if (!expr) return [];

  const refs: ColumnRefItem[] = [];

  // TODO - why not "exp" ?
  switch (expr.type) {
    case "column_ref":
      refs.push(expr as ColumnRefItem);
      break;

    case "binary_expr": {
      const binary = expr as Binary;
      refs.push(...extractColumnRefs(binary.left));
      refs.push(...extractColumnRefs(binary.right));
      break;
    }

    case "aggr_func": {
      const aggr = expr as AggrFunc;
      if (aggr.args?.expr) {
        refs.push(...extractColumnRefs(aggr.args.expr));
      }
      break;
    }

    case "function": {
      const func = expr as AstFunction;
      if (func.args?.value) {
        for (const arg of func.args.value) {
          refs.push(...extractColumnRefs(arg));
        }
      }
      break;
    }

    case "case": {
      const caseExpr = expr as Case;
      if (caseExpr.args) {
        for (const arg of caseExpr.args) {
          if (arg.type === "when" && arg.cond) {
            refs.push(...extractColumnRefs(arg.cond));
          }
          if (arg.result) {
            refs.push(...extractColumnRefs(arg.result));
          }
        }
      }
      break;
    }

    case "interval": {
      const interval = expr as Interval;
      if (interval.expr) {
        refs.push(...extractColumnRefs(interval.expr));
      }
      break;
    }

    case "cast": {
      const cast = expr as Cast;
      if (cast.expr) {
        refs.push(...extractColumnRefs(cast.expr));
      }
      break;
    }

    default:
      // Handle nested expressions in unknown types
      if (typeof expr === "object" && expr !== null) {
        for (const key of Object.keys(expr)) {
          const value = (expr as Record<string, unknown>)[key];
          if (value && typeof value === "object" && "type" in value) {
            refs.push(...extractColumnRefs(value as ExpressionValue));
          }
        }
      }
      break;
  }

  return refs;
}

/**
 * Get transformations from expression, now supporting CASE/IF for CONDITION subtype
 */
export function getDirectTransformationsFromExprValue(
  expr: ExpressionValue,
  parentTransformation?: Transformation,
): Record<string, TransformationSet> {
  switch (expr.type) {
    case "column_ref": {
      const inputColumnName = formatInputColumnName(expr as ColumnRefItem);

      return inputColumnName
        ? {
            [inputColumnName]: new TransformationSet([mergeTransformations(parentTransformation, DIRECT_IDENTITY)]),
          }
        : {};
    }

    case "binary_expr": {
      const { left, right } = expr as Binary;

      const merged: Record<string, TransformationSet> = {};

      Object.entries(
        getDirectTransformationsFromExprValue(left, mergeTransformations(parentTransformation, DIRECT_TRANSFORMATION)),
      ).forEach(([key, value]) => {
        merged[key] = value;
      });

      Object.entries(
        getDirectTransformationsFromExprValue(right, mergeTransformations(parentTransformation, DIRECT_TRANSFORMATION)),
      ).forEach(([key, value]) => {
        const prev = merged[key];

        if (prev) {
          merged[key] = prev.intersection(value);
        } else {
          merged[key] = value;
        }
      });

      return merged;
    }

    case "aggr_func": {
      const aggExpr = expr as AggrFunc;

      return getDirectTransformationsFromExprValue(
        aggExpr.args.expr,
        mergeTransformations(parentTransformation, {
          ...DIRECT_AGGREGATION,
          masking: MASKING_AGG_FUNCTIONS.has(aggExpr.name),
        }),
      );
    }

    case "function": {
      const funcExpr = expr as AstFunction;

      return (
        funcExpr.args?.value.reduce(
          (acc, arg) => {
            const argTransformations = getDirectTransformationsFromExprValue(
              arg,
              mergeTransformations(parentTransformation, {
                ...DIRECT_TRANSFORMATION,
                masking:
                  funcExpr.name.name.length > 0 &&
                  MASKING_FUNCTIONS.has(funcExpr.name.name.at(-1)!.value.toUpperCase()),
              }),
            );

            Object.entries(argTransformations).forEach(([key, value]) => {
              acc[key] = acc[key] ? acc[key].intersection(value) : value;
            });

            return acc;
          },
          {} as Record<string, TransformationSet>,
        ) ?? {}
      );
    }

    case "case": {
      const caseExpr = expr as Case;
      const merged: Record<string, TransformationSet> = {};

      if (caseExpr.args) {
        for (const arg of caseExpr.args) {
          // Condition columns get INDIRECT/CONDITION
          if (arg.type === "when" && arg.cond) {
            const condTransformations = getIndirectTransformationsFromExpr(arg.cond, INDIRECT_CONDITION);
            Object.entries(condTransformations).forEach(([key, value]) => {
              merged[key] = merged[key] ? merged[key].union(value) : value;
            });
          }

          // Result columns get DIRECT/TRANSFORMATION (value is transformed through CASE)
          if (arg.result) {
            const resultTransformations = getDirectTransformationsFromExprValue(
              arg.result,
              mergeTransformations(parentTransformation, DIRECT_TRANSFORMATION),
            );
            Object.entries(resultTransformations).forEach(([key, value]) => {
              merged[key] = merged[key] ? merged[key].union(value) : value;
            });
          }
        }
      }

      return merged;
    }

    case "cast": {
      const castExpr = expr as Cast;
      if (castExpr.expr) {
        return getDirectTransformationsFromExprValue(
          castExpr.expr,
          mergeTransformations(parentTransformation, DIRECT_TRANSFORMATION),
        );
      }
      return {};
    }

    case "interval": {
      const intervalExpr = expr as Interval;
      if (intervalExpr.expr) {
        return getDirectTransformationsFromExprValue(
          intervalExpr.expr,
          mergeTransformations(parentTransformation, DIRECT_TRANSFORMATION),
        );
      }
      return {};
    }

    default:
      return {};
  }
}

/**
 * Get indirect transformations from an expression with a specific transformation type
 */
export function getIndirectTransformationsFromExpr(
  expr: ExpressionValue | null | undefined,
  transformation: Transformation,
): Record<string, TransformationSet> {
  if (!expr) return {};

  const columnRefs = extractColumnRefs(expr);
  const result: Record<string, TransformationSet> = {};

  for (const ref of columnRefs) {
    const columnName = formatInputColumnName(ref);
    if (columnName) {
      result[columnName] = new TransformationSet([transformation]);
    }
  }

  return result;
}

/**
 * Extract JOIN lineage from FROM clause
 */
export function getJoinLineage(select: Select, schema: Schema): InputField[] {
  const inputFields: InputField[] = [];

  if (!select.from) return inputFields;

  const fromItems = Array.isArray(select.from) ? select.from : [select.from];
  const { regularTables } = getTableExpressionsFromSelect(select);

  for (const item of fromItems) {
    // Check for JOIN conditions
    if ("on" in item && item.on) {
      const columnRefs = extractColumnRefs(item.on as ExpressionValue);

      for (const ref of columnRefs) {
        const columnName = getInputColumnName(ref);
        const tableName = ref.table;

        if (columnName) {
          // Find the table - tableName might be an alias, so check against both table name and alias
          const table = regularTables.find(
            (t) =>
              (!tableName || tableName === t.table || tableName === t.as) &&
              schema.tables.some((s) => s.name === t.table && s.columns.includes(columnName)),
          );

          if (table) {
            const schemaTable = schema.tables.find((s) => s.name === table.table);
            if (schemaTable) {
              inputFields.push({
                namespace: schema.namespace,
                name: schemaTable.name,
                field: columnName,
                transformations: [INDIRECT_JOIN],
              });
            }
          }
        }
      }
    }

    // Check for USING clause
    if ("using" in item && Array.isArray(item.using)) {
      for (const usingCol of item.using) {
        // USING columns exist in multiple tables
        for (const schemaTable of schema.tables) {
          if (schemaTable.columns.includes(usingCol)) {
            inputFields.push({
              namespace: schema.namespace,
              name: schemaTable.name,
              field: usingCol,
              transformations: [INDIRECT_JOIN],
            });
          }
        }
      }
    }
  }

  return inputFields;
}

/**
 * Extract WHERE clause lineage (FILTER)
 */
export function getFilterLineage(select: Select, schema: Schema): InputField[] {
  const inputFields: InputField[] = [];

  if (!select.where) return inputFields;

  const columnRefs = extractColumnRefs(select.where as ExpressionValue);
  const { regularTables } = getTableExpressionsFromSelect(select);

  for (const ref of columnRefs) {
    const columnName = getInputColumnName(ref);
    const tableName = ref.table;

    if (columnName) {
      // Find the table in schema
      const table = regularTables.find(
        (t) =>
          (!tableName || tableName === t.table || tableName === t.as) &&
          schema.tables.some((s) => s.name === t.table && s.columns.includes(columnName)),
      );

      if (table) {
        const schemaTable = schema.tables.find((s) => s.name === table.table);
        if (schemaTable) {
          inputFields.push({
            namespace: schema.namespace,
            name: schemaTable.name,
            field: columnName,
            transformations: [INDIRECT_FILTER],
          });
        }
      }
    }
  }

  return inputFields;
}

/**
 * Extract GROUP BY lineage
 */
export function getGroupByLineage(select: Select, schema: Schema): InputField[] {
  const inputFields: InputField[] = [];

  if (!select.groupby) return inputFields;

  // Handle both array format and object with columns property
  let groupByItems: ExpressionValue[];
  if (Array.isArray(select.groupby)) {
    groupByItems = select.groupby;
  } else if (
    typeof select.groupby === "object" &&
    "columns" in select.groupby &&
    Array.isArray(select.groupby.columns)
  ) {
    groupByItems = select.groupby.columns;
  } else {
    groupByItems = [select.groupby as unknown as ExpressionValue];
  }
  const { regularTables } = getTableExpressionsFromSelect(select);

  for (const item of groupByItems) {
    const columnRefs = extractColumnRefs(item as ExpressionValue);

    for (const ref of columnRefs) {
      const columnName = getInputColumnName(ref);
      const tableName = ref.table;

      if (columnName) {
        const table = regularTables.find(
          (t) =>
            (!tableName || tableName === t.table || tableName === t.as) &&
            schema.tables.some((s) => s.name === t.table && s.columns.includes(columnName)),
        );

        if (table) {
          const schemaTable = schema.tables.find((s) => s.name === table.table);
          if (schemaTable) {
            inputFields.push({
              namespace: schema.namespace,
              name: schemaTable.name,
              field: columnName,
              transformations: [INDIRECT_GROUP_BY],
            });
          }
        }
      }
    }
  }

  return inputFields;
}

/**
 * Extract ORDER BY lineage (SORT)
 */
export function getOrderByLineage(select: Select, schema: Schema): InputField[] {
  const inputFields: InputField[] = [];

  if (!select.orderby) return inputFields;

  const orderByItems = Array.isArray(select.orderby) ? select.orderby : [select.orderby];
  const { regularTables } = getTableExpressionsFromSelect(select);

  for (const item of orderByItems) {
    const expr = "expr" in item ? item.expr : item;
    const columnRefs = extractColumnRefs(expr as ExpressionValue);

    for (const ref of columnRefs) {
      const columnName = getInputColumnName(ref);
      const tableName = ref.table;

      if (columnName) {
        const table = regularTables.find(
          (t) =>
            (!tableName || tableName === t.table || tableName === t.as) &&
            schema.tables.some((s) => s.name === t.table && s.columns.includes(columnName)),
        );

        if (table) {
          const schemaTable = schema.tables.find((s) => s.name === table.table);
          if (schemaTable) {
            inputFields.push({
              namespace: schema.namespace,
              name: schemaTable.name,
              field: columnName,
              transformations: [INDIRECT_SORT],
            });
          }
        }
      }
    }
  }

  return inputFields;
}

/**
 * Extract WINDOW function lineage from SELECT columns
 */
export function getWindowLineage(select: Select, schema: Schema): InputField[] {
  const inputFields: InputField[] = [];
  const { regularTables } = getTableExpressionsFromSelect(select);

  if (!select.columns || (typeof select.columns === "string" && select.columns === "*")) return inputFields;

  for (const col of select.columns) {
    if (!isColumn(col)) continue;

    // Check if this is a window function (has OVER clause)
    const expr = col.expr;
    if (expr.type === "aggr_func" && "over" in expr && (expr as AggrFunc & { over?: unknown }).over) {
      const aggrFunc = expr as AggrFunc & {
        over?: {
          partitionby?: ExpressionValue[];
          orderby?: Array<{ expr: ExpressionValue }>;
        };
      };

      // Extract PARTITION BY columns
      if (aggrFunc.over?.partitionby) {
        for (const partExpr of aggrFunc.over.partitionby) {
          const columnRefs = extractColumnRefs(partExpr);
          for (const ref of columnRefs) {
            const columnName = getInputColumnName(ref);
            const tableName = ref.table;

            if (columnName) {
              const table = regularTables.find(
                (t) =>
                  (!tableName || tableName === t.table || tableName === t.as) &&
                  schema.tables.some((s) => s.name === t.table && s.columns.includes(columnName)),
              );

              if (table) {
                const schemaTable = schema.tables.find((s) => s.name === table.table);
                if (schemaTable) {
                  inputFields.push({
                    namespace: schema.namespace,
                    name: schemaTable.name,
                    field: columnName,
                    transformations: [INDIRECT_WINDOW],
                  });
                }
              }
            }
          }
        }
      }

      // Extract ORDER BY within OVER clause
      if (aggrFunc.over?.orderby) {
        for (const orderItem of aggrFunc.over.orderby) {
          const columnRefs = extractColumnRefs(orderItem.expr);
          for (const ref of columnRefs) {
            const columnName = getInputColumnName(ref);
            const tableName = ref.table;

            if (columnName) {
              const table = regularTables.find(
                (t) =>
                  (!tableName || tableName === t.table || tableName === t.as) &&
                  schema.tables.some((s) => s.name === t.table && s.columns.includes(columnName)),
              );

              if (table) {
                const schemaTable = schema.tables.find((s) => s.name === table.table);
                if (schemaTable) {
                  inputFields.push({
                    namespace: schema.namespace,
                    name: schemaTable.name,
                    field: columnName,
                    transformations: [INDIRECT_WINDOW],
                  });
                }
              }
            }
          }
        }
      }
    }
  }

  return inputFields;
}

/**
 * Extract HAVING clause lineage (combines FILTER with AGGREGATION context)
 */
export function getHavingLineage(select: Select, schema: Schema): InputField[] {
  const inputFields: InputField[] = [];

  if (!select.having) return inputFields;

  // TODO - check type
  const columnRefs = extractColumnRefs(select.having as unknown as ExpressionValue);
  const { regularTables } = getTableExpressionsFromSelect(select);

  for (const ref of columnRefs) {
    const columnName = getInputColumnName(ref);
    const tableName = ref.table;

    if (columnName) {
      const table = regularTables.find(
        (t) =>
          (!tableName || tableName === t.table || tableName === t.as) &&
          schema.tables.some((s) => s.name === t.table && s.columns.includes(columnName)),
      );

      if (table) {
        const schemaTable = schema.tables.find((s) => s.name === table.table);
        if (schemaTable) {
          inputFields.push({
            namespace: schema.namespace,
            name: schemaTable.name,
            field: columnName,
            transformations: [INDIRECT_FILTER],
          });
        }
      }
    }
  }

  return inputFields;
}

export function getTableExpressionsFromSelect(select: Select): {
  regularTables: BaseFrom[];
  selectTables: SelectWithAlias[];
} {
  const regularTables: BaseFrom[] = [];
  const selectTables: SelectWithAlias[] = [];

  const previousWiths: With[] = [];
  const withByNames: Map<string, SelectWithAlias> = new Map();

  if (select.with) {
    select.with.forEach((withItem) => {
      const s = withItem.stmt.ast ?? withItem.stmt;

      withByNames.set(withItem.name.value, {
        ...s,
        as: withItem.name.value,
        with: [...previousWiths], // keep previous with statements
      });

      previousWiths.push(withItem);
    });
  }

  if (select.from) {
    const fromItems = Array.isArray(select.from) ? select.from : [select.from];

    fromItems.forEach((item) => {
      if ("table" in item) {
        // might mention with statement in our select
        const matchingWith = withByNames.get(item.table);

        if (matchingWith) {
          selectTables.push({
            ...matchingWith,
            as: item.as ?? matchingWith.as,
          });
        } else {
          regularTables.push(item);
        }
      } else if ("expr" in item) {
        selectTables.push({
          ...item.expr.ast,
          as: item.as,
          with: previousWiths, // propagate previous withs
        });
      }
    });
  }

  return { regularTables, selectTables };
}

export function mergeTransformationSet(parent: TransformationSet, child: TransformationSet): TransformationSet {
  const merged = new TransformationSet();

  parent.forEach((tp) => {
    child.forEach((tc) => {
      merged.add(mergeTransformations(tp, tc));
    });
  });

  return merged;
}

export function getColumnLineage(
  select: Select,
  schema: Schema,
  column: AstColumn,
  transformations?: TransformationSet,
): InputField[] {
  let transformationsByColumns = getDirectTransformationsFromExprValue(column.expr);

  if (transformations) {
    transformationsByColumns = Object.entries(transformationsByColumns).reduce(
      (acc, [columnName, childTransformations]) => {
        acc[columnName] = mergeTransformationSet(transformations, childTransformations);

        return acc;
      },
      {} as Record<string, TransformationSet>,
    );
  }

  const { regularTables, selectTables } = getTableExpressionsFromSelect(select);

  const inputFields: InputField[] = [];

  for (const [inputColumnName, transformations] of Object.entries(transformationsByColumns)) {
    const inputColumn = parseInputColumnName(inputColumnName);

    const table = regularTables.find(
      (t) =>
        (!inputColumn.table || inputColumn.table === t.table || inputColumn.table === t.as) &&
        schema.tables.some((s) => s.name === t.table && s.columns.some((c) => c === inputColumn.name)),
    );

    if (table) {
      inputFields.push({
        namespace: schema.namespace,
        name: table.table,
        field: inputColumn.name,
        transformations: Array.from(transformations),
      });
    } else {
      for (const selectTable of selectTables) {
        if (inputColumn.table && inputColumn.table !== selectTable.as) {
          continue;
        }

        const matchingColumn = selectTable.columns.find((c) => getOutputColumnName(c) === inputColumn.name);

        let nextColumn: AstColumn;

        if (matchingColumn) {
          nextColumn = matchingColumn;
        } else {
          nextColumn = column;

          // stop propagating table of column as it is only in the context of the select
          if (nextColumn.expr.type === "column_ref") {
            const expr = nextColumn.expr as ColumnRefItem;

            expr.table = null;
          }
        }

        inputFields.push(...getColumnLineage(selectTable, schema, nextColumn, transformations));
      }
    }
  }

  return inputFields;
}

/**
 * Get all dataset-level indirect lineage (columns that affect the entire result set)
 */
export function getDatasetLineage(select: Select, schema: Schema): InputField[] {
  const allIndirectFields: InputField[] = [];

  // Collect all indirect lineage
  allIndirectFields.push(...getJoinLineage(select, schema));
  allIndirectFields.push(...getFilterLineage(select, schema));
  allIndirectFields.push(...getGroupByLineage(select, schema));
  allIndirectFields.push(...getOrderByLineage(select, schema));
  allIndirectFields.push(...getWindowLineage(select, schema));
  allIndirectFields.push(...getHavingLineage(select, schema));

  // Deduplicate by creating a map keyed by namespace.table.field.type.subtype
  const deduped = new Map<string, InputField>();
  for (const field of allIndirectFields) {
    const transformation = field.transformations?.[0];
    const key = `${field.namespace}.${field.name}.${field.field}.${transformation?.type}.${transformation?.subtype}`;
    if (!deduped.has(key)) {
      deduped.set(key, field);
    }
  }

  return Array.from(deduped.values());
}

/**
 * Main lineage extraction function - returns field-level lineage only (backward compatible)
 */
export function getLineage(select: Select, schema: Schema): ColumnLineageDatasetFacet["fields"] {
  let unknownCount = 0;

  return select.columns.reduce((acc, column) => {
    if (!isColumn(column)) {
      return acc;
    }

    let outputFieldName = getOutputColumnName(column);

    if (!outputFieldName) {
      outputFieldName = `unknown_${unknownCount++}`;
    }

    return {
      ...acc,
      [outputFieldName]: {
        inputFields: getColumnLineage(select, schema, column),
      },
    };
  }, {});
}

/**
 * Extended lineage extraction function - returns both field-level and dataset-level lineage
 */
export function getExtendedLineage(
  select: Select,
  schema: Schema,
): Pick<ColumnLineageDatasetFacet, "fields" | "dataset"> {
  return {
    fields: getLineage(select, schema),
    dataset: getDatasetLineage(select, schema),
  };
}

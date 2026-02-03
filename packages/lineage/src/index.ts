import {
  type ColumnLineageDatasetFacet,
  type InputField,
  type Transformation as _Transformation,
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

/**
 * Merges two transformations, combining their properties based on precedence rules.
 *
 * Precedence rules:
 * - If types differ (DIRECT vs INDIRECT), keeps the child transformation
 * - For DIRECT types: AGGREGATION > TRANSFORMATION > IDENTITY
 * - For INDIRECT types: prefers the child (more recent context)
 * - Masking is OR'd together (if either is masked, result is masked)
 *
 * @param parent - The parent/outer transformation (may be undefined)
 * @param child - The child/inner transformation to merge
 * @returns The merged transformation with combined properties
 */
function mergeTransformations(parent: Transformation | undefined, child: Transformation): Transformation {
  if (!parent) {
    return child;
  }

  // If types differ, prefer the more specific one
  // INDIRECT is generally more specific than DIRECT for the same column
  if (parent.type !== child.type) {
    let leading: Transformation = child.type === "INDIRECT" ? child : parent;
    return { ...leading, masking: parent.masking || child.masking };
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

const transformationHasher = (value: Transformation): string =>
  `${value.type}-${value.subtype}-${value.masking ? "MASKED" : "UNMASKED"}`;

class TransformationSet extends HashSet<Transformation> {
  constructor(values?: readonly Transformation[]) {
    super((value: Transformation) => transformationHasher(value));

    if (values) {
      values.forEach((value) => this.add(value));
    }
  }
}

/**
 * Unified column lineage result that contains both direct and indirect transformations
 * per column reference. Used internally to collect all transformations for columns.
 */
type ColumnTransformations = Record<string, TransformationSet>;

export type Column = {
  name: string;
};

export type Table = {
  name: string; // Format: schemaName.tableName
  columns: string[];
};

export type Namespace = {
  namespace: string;
  tables?: Table[];
  defaultSchema?: string;
};

/**
 * @deprecated Use Namespace instead
 */
export type Schema = Namespace;

export type InputColumn = {
  name: string;
  table?: string;
};

export type SelectWithAlias = Select & {
  as?: string | null;
};

/**
 * Set operation type for UNION, INTERSECT, EXCEPT
 */
export type SetOperation = "union" | "union all" | "intersect" | "intersect all" | "except" | "except all";

/**
 * Extended lineage result that includes both field-level and dataset-level lineage
 */
export type ExtendedLineageResult = Pick<ColumnLineageDatasetFacet, "fields" | "dataset">;

function isColumn(selectColumn: Select["columns"][number]): selectColumn is AstColumn {
  return (
    typeof selectColumn === "object" &&
    selectColumn !== null &&
    "as" in selectColumn &&
    "expr" in selectColumn &&
    typeof selectColumn.expr === "object" &&
    selectColumn.expr !== null
  );
}

/**
 * Checks if a column expression is a star (wildcard) expression like `*` or `table.*`.
 */
function isStar(column: AstColumn): boolean {
  if (column.expr.type !== "column_ref") return false;
  const colRef = column.expr as ColumnRefItem;
  return colRef.column === "*" || (typeof colRef.column === "object" && colRef.column?.expr?.value === "*");
}

/**
 * Extracts the table qualifier from a star expression.
 * @returns The table alias/name (e.g., "u" from "u.*"), or null for plain "*"
 * @calls isStar - To verify the column is a star expression
 */
function getStarTableQualifier(column: AstColumn): string | null {
  if (!isStar(column)) return null;
  const colRef = column.expr as ColumnRefItem;
  if (!colRef.table) return null;
  return typeof colRef.table === "string" ? colRef.table : (colRef.table as { type: string; value: string }).value;
}

/**
 * Formats a column reference into a string identifier.
 * @returns Formatted string like "table.column" or just "column" if no table qualifier
 * @calls getInputColumnName - To extract the column name from the reference
 */
export function formatInputColumnName(column: ColumnRefItem): string {
  return `${column.table ? `${column.table}.` : ""}${getInputColumnName(column)}`;
}

/**
 * Parses a formatted column name string back into its components.
 * @returns InputColumn object with name and optional table properties
 */
export function parseInputColumnName(column: string): InputColumn {
  const parts = column.split(".");
  const name = parts.pop() || "";
  const table = parts.length > 0 ? parts.join(".") : undefined;

  return { name, table };
}

/**
 * Parses a fully qualified table name into schema and table components.
 * @returns Object with schema (empty string if not specified) and table name
 */
export function parseTableName(tableName: string): { schema: string; table: string } {
  const parts = tableName.split(".");
  if (parts.length === 1) {
    return { schema: "", table: parts[0]! };
  }
  return { schema: parts[0]!, table: parts.slice(1).join(".") };
}

/**
 * Checks if an AST table reference matches a schema table definition.
 * Handles schema resolution including default schema fallback.
 * @returns True if the AST table matches the schema table
 *
 * @calls parseTableName - To parse the schema table name into components
 */
function astTableMatchesSchemaTable(astTable: BaseFrom, schemaTableName: string, defaultSchema?: string): boolean {
  const parsed = parseTableName(schemaTableName);
  const astDb = astTable.db;
  const effectiveAstSchema = astDb || defaultSchema;

  // Compare schema (or default schema if not specified)
  if (
    (parsed.schema && !defaultSchema && !astDb) ||
    (parsed.schema && effectiveAstSchema && parsed.schema !== effectiveAstSchema)
  ) {
    return false;
  }

  // Compare table name
  return parsed.table === astTable.table;
}

/**
 * Extracts the column name from a ColumnRefItem AST node.
 * Handles both simple string columns and complex expression columns.
 * @returns The column name string, or null if it cannot be extracted
 */
export function getInputColumnName(column: ColumnRefItem): string | null {
  return typeof column.column === "string"
    ? column.column
    : typeof column.column.expr.value === "string"
      ? column.column.expr.value
      : null;
}

/**
 * Determines the output column name for a SELECT column.
 * Uses the alias if present, otherwise extracts from the column reference.
 * @returns The output column name (alias or original name), or null if undetermined
 * @calls getInputColumnName - When no alias is present and expr is a column_ref
 * @example
 * // For "SELECT id AS user_id" returns "user_id"
 * // For "SELECT id" returns "id"
 * // For "SELECT 1 + 1" returns null (no determinable name)
 */
export function getOutputColumnName(column: AstColumn): string | null {
  if (column.as) {
    return typeof column.as === "string" ? column.as : column.as.value;
  } else if (column.expr.type === "column_ref") {
    return getInputColumnName(column.expr as ColumnRefItem);
  }

  return null;
}

/**
 * Recursively extracts all column references from any SQL expression.
 * This is the unified function for finding all columns referenced in expressions.
 * @returns Array of ColumnRefItem objects found in the expression
 * @calls extractColumnRefs - Recursively for nested expressions
 */
export function extractColumnRefs(expr: ExpressionValue | null | undefined): ColumnRefItem[] {
  if (!expr) return [];

  const refs: ColumnRefItem[] = [];

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
 * Type for OVER clause structure (shared between aggr_func and function types)
 */
type OverClause = {
  // Direct structure (legacy/simple case)
  partitionby?: ExpressionValue[];
  orderby?: Array<{ expr: ExpressionValue }>;
  // Nested structure (Trino parser output)
  as_window_specification?: {
    window_specification?: {
      partitionby?: Array<{ expr: ExpressionValue }>;
      orderby?: Array<{ expr: ExpressionValue }>;
    };
  };
};

/**
 * Extracts PARTITION BY and ORDER BY expressions from an OVER clause.
 * Handles both direct structure and nested Trino parser output structure.
 * @returns Array of expressions from PARTITION BY and ORDER BY clauses
 */
function extractWindowExpressionsFromOver(over: OverClause): ExpressionValue[] {
  const expressions: ExpressionValue[] = [];

  // Handle nested structure (Trino parser output)
  const windowSpec = over.as_window_specification?.window_specification;
  if (windowSpec) {
    if (windowSpec.partitionby) {
      expressions.push(...windowSpec.partitionby.map((item) => item.expr));
    }
    if (windowSpec.orderby) {
      expressions.push(...windowSpec.orderby.map((item) => item.expr));
    }
  }

  // Handle direct structure (legacy/simple case) as fallback
  if (expressions.length === 0) {
    if (over.partitionby) {
      expressions.push(...over.partitionby);
    }
    if (over.orderby) {
      expressions.push(...over.orderby.map((item) => item.expr));
    }
  }

  return expressions;
}

/**
 * Core unified function for extracting column transformations from any SQL expression.
 * Returns a map of column names to their transformation sets.
 *
 * This function handles:
 * - column_ref: Returns DIRECT/IDENTITY transformation
 * - binary_expr: Returns DIRECT/TRANSFORMATION for both operands
 * - aggr_func: Returns DIRECT/AGGREGATION (with masking for COUNT)
 * - function: Returns DIRECT/TRANSFORMATION (with masking for hash functions)
 * - case: Returns INDIRECT/CONDITION for conditions, DIRECT/IDENTITY for results
 * - cast/interval: Returns DIRECT/TRANSFORMATION
 *
 * @param expr - The expression to extract transformations from
 * @param parentTransformation - Optional parent transformation to merge with child transformations
 * @returns Map of column names (e.g., "table.column") to their TransformationSet
 *
 * @calls formatInputColumnName - To format column references as keys
 * @calls mergeTransformations - To combine parent and child transformations
 * @calls extractWindowExpressionsFromOver - For window function OVER clauses
 * @calls extractTransformationsWithType - For CASE condition columns
 * @calls extractTransformationsFromExpr - Recursively for nested expressions
 */
function extractTransformationsFromExpr(
  expr: ExpressionValue,
  parentTransformation?: Transformation,
): ColumnTransformations {
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

      const merged: ColumnTransformations = {};

      Object.entries(
        extractTransformationsFromExpr(left, mergeTransformations(parentTransformation, DIRECT_TRANSFORMATION)),
      ).forEach(([key, value]) => {
        merged[key] = value;
      });

      Object.entries(
        extractTransformationsFromExpr(right, mergeTransformations(parentTransformation, DIRECT_TRANSFORMATION)),
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

      const merged: ColumnTransformations = {};

      // Extract lineage from aggregate function arguments
      if (aggExpr.args?.expr) {
        const argTransformations = extractTransformationsFromExpr(
          aggExpr.args.expr,
          mergeTransformations(parentTransformation, {
            ...DIRECT_AGGREGATION,
            masking: MASKING_AGG_FUNCTIONS.has(aggExpr.name),
          }),
        );
        Object.entries(argTransformations).forEach(([key, value]) => {
          merged[key] = merged[key] ? merged[key].union(value) : value;
        });
      }

      // For window functions (aggr_func with OVER clause), also extract columns from PARTITION BY/ORDER BY
      if ("over" in aggExpr && aggExpr.over) {
        const windowExprs = extractWindowExpressionsFromOver(aggExpr.over);
        for (const windowExpr of windowExprs) {
          const windowTransformations = extractTransformationsFromExpr(
            windowExpr,
            mergeTransformations(parentTransformation, INDIRECT_WINDOW),
          );
          Object.entries(windowTransformations).forEach(([key, value]) => {
            merged[key] = merged[key] ? merged[key].union(value) : value;
          });
        }
      }

      return merged;
    }

    case "function": {
      const funcExpr = expr as AstFunction;
      const merged: ColumnTransformations = {};

      // Extract lineage from function arguments
      if (funcExpr.args?.value) {
        for (const arg of funcExpr.args.value) {
          const argTransformations = extractTransformationsFromExpr(
            arg,
            mergeTransformations(parentTransformation, {
              ...DIRECT_TRANSFORMATION,
              masking:
                funcExpr.name.name.length > 0 && MASKING_FUNCTIONS.has(funcExpr.name.name.at(-1)!.value.toUpperCase()),
            }),
          );
          Object.entries(argTransformations).forEach(([key, value]) => {
            merged[key] = merged[key] ? merged[key].union(value) : value;
          });
        }
      }

      // For window functions (function with OVER clause like RANK(), ROW_NUMBER()),
      // extract columns from PARTITION BY/ORDER BY since these functions have no arguments
      if ("over" in funcExpr && funcExpr.over) {
        const windowExprs = extractWindowExpressionsFromOver((funcExpr as AstFunction & { over: OverClause }).over);
        for (const windowExpr of windowExprs) {
          const windowTransformations = extractTransformationsFromExpr(
            windowExpr,
            mergeTransformations(parentTransformation, INDIRECT_WINDOW),
          );
          Object.entries(windowTransformations).forEach(([key, value]) => {
            merged[key] = merged[key] ? merged[key].union(value) : value;
          });
        }
      }

      return merged;
    }

    case "case": {
      const caseExpr = expr as Case;
      const merged: ColumnTransformations = {};

      if (caseExpr.args) {
        for (const arg of caseExpr.args) {
          // Condition columns get INDIRECT/CONDITION (per-column indirect transformation)
          if (arg.type === "when" && arg.cond) {
            const condTransformations = extractTransformationsWithType(arg.cond, INDIRECT_CONDITION);
            Object.entries(condTransformations).forEach(([key, value]) => {
              merged[key] = merged[key] ? merged[key].union(value) : value;
            });
          }

          // Result columns get DIRECT/IDENTITY (value is taken from CASE result)
          if (arg.result) {
            const resultTransformations = extractTransformationsFromExpr(
              arg.result,
              mergeTransformations(parentTransformation, DIRECT_IDENTITY),
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
        return extractTransformationsFromExpr(
          castExpr.expr,
          mergeTransformations(parentTransformation, DIRECT_TRANSFORMATION),
        );
      }
      return {};
    }

    case "interval": {
      const intervalExpr = expr as Interval;
      if (intervalExpr.expr) {
        return extractTransformationsFromExpr(
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
 * Extracts column references and applies a uniform transformation type to all.
 * Simpler than extractTransformationsFromExpr - doesn't analyze expression structure.
 *
 * Used for dataset-level indirect transformations where all columns in an expression
 * receive the same transformation type (e.g., all columns in WHERE get FILTER).
 * @returns Map of column names to TransformationSet containing the single transformation
 *
 * @calls extractColumnRefs - To find all column references in the expression
 * @calls formatInputColumnName - To format column references as keys
 */
function extractTransformationsWithType(
  expr: ExpressionValue | null | undefined,
  transformation: Transformation,
): ColumnTransformations {
  if (!expr) return {};

  const columnRefs = extractColumnRefs(expr);
  const result: ColumnTransformations = {};

  for (const ref of columnRefs) {
    const columnName = formatInputColumnName(ref);
    if (columnName) {
      result[columnName] = new TransformationSet([transformation]);
    }
  }

  return result;
}

/**
 * Resolves a column reference to an InputField by finding the matching table in namespace.
 * This is the core helper for converting AST column refs to OpenLineage InputField format.
 * @returns InputField object if table found, null otherwise
 *
 * @calls getInputColumnName - To extract the column name
 * @calls astTableMatchesSchemaTable - To match AST table to namespace table
 */
function resolveColumnRefToInputField(
  ref: ColumnRefItem,
  regularTables: BaseFrom[],
  namespace: Namespace,
  transformation: Transformation,
): InputField | null {
  const columnName = getInputColumnName(ref);
  const tableName = ref.table;

  if (!columnName) return null;
  if (!namespace.tables) return null;

  const table = regularTables.find(
    (t) =>
      (!tableName || tableName === t.table || tableName === t.as) &&
      namespace.tables!.some(
        (s) => astTableMatchesSchemaTable(t, s.name, namespace.defaultSchema) && s.columns.includes(columnName),
      ),
  );

  if (!table) return null;

  const schemaTable = namespace.tables.find((s) => astTableMatchesSchemaTable(table, s.name, namespace.defaultSchema));
  if (!schemaTable) return null;

  return {
    namespace: namespace.namespace,
    name: schemaTable.name,
    field: columnName,
    transformations: [transformation],
  };
}

/**
 * Extracts InputFields from all column references in an expression.
 * Used by dataset-level lineage extraction (WHERE, HAVING, GROUP BY, ORDER BY, etc.).
 * @returns Array of InputField objects for columns that could be resolved
 *
 * @calls extractColumnRefs - To find all column references
 * @calls resolveColumnRefToInputField - To convert each ref to InputField
 */
function extractInputFieldsFromExpression(
  expr: ExpressionValue | null | undefined,
  regularTables: BaseFrom[],
  namespace: Namespace,
  transformation: Transformation,
): InputField[] {
  if (!expr) return [];

  const columnRefs = extractColumnRefs(expr);
  const inputFields: InputField[] = [];

  for (const ref of columnRefs) {
    const inputField = resolveColumnRefToInputField(ref, regularTables, namespace, transformation);
    if (inputField) {
      inputFields.push(inputField);
    }
  }

  return inputFields;
}

/**
 * Extracts JOIN lineage from the FROM clause (ON and USING conditions).
 * All columns in JOIN conditions receive INDIRECT/JOIN transformation.
 * @returns Array of InputFields for columns used in JOIN conditions
 *
 * @calls getTableExpressionsFromSelect - To get regular tables from FROM
 * @calls extractInputFieldsFromExpression - For ON clause columns
 * @calls astTableMatchesSchemaTable - For USING clause table matching
 */
function getJoinLineage(select: Select, namespace: Namespace): InputField[] {
  if (!select.from) return [];
  if (!namespace.tables) return [];

  const fromItems = Array.isArray(select.from) ? select.from : [select.from];
  const { regularTables } = getTableExpressionsFromSelect(select);
  const inputFields: InputField[] = [];

  for (const item of fromItems) {
    // Handle ON clause
    if ("on" in item && item.on) {
      inputFields.push(...extractInputFieldsFromExpression(item.on, regularTables, namespace, INDIRECT_JOIN));
    }

    // Handle USING clause - columns exist in multiple tables
    if ("using" in item && Array.isArray(item.using)) {
      for (const usingCol of item.using) {
        // Find tables that match the FROM clause and have this column
        for (const schemaTable of namespace.tables) {
          const matchingFromTable = regularTables.find((t) =>
            astTableMatchesSchemaTable(t, schemaTable.name, namespace.defaultSchema),
          );
          if (matchingFromTable && schemaTable.columns.includes(usingCol)) {
            inputFields.push({
              namespace: namespace.namespace,
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
 * Extracts WHERE clause lineage.
 * All columns in WHERE conditions receive INDIRECT/FILTER transformation.
 * @returns Array of InputFields for columns used in WHERE clause
 *
 * @calls getTableExpressionsFromSelect - To get regular tables from FROM
 * @calls extractInputFieldsFromExpression - To extract columns with FILTER transformation
 */
function getFilterLineage(select: Select, namespace: Namespace): InputField[] {
  if (!select.where) return [];

  const { regularTables } = getTableExpressionsFromSelect(select);
  return extractInputFieldsFromExpression(select.where, regularTables, namespace, INDIRECT_FILTER);
}

/**
 * Extracts GROUP BY clause lineage.
 * All columns in GROUP BY receive INDIRECT/GROUP_BY transformation.
 * @returns Array of InputFields for columns used in GROUP BY clause
 *
 * @calls normalizeGroupByItems - To handle different GROUP BY AST formats
 * @calls getTableExpressionsFromSelect - To get regular tables from FROM
 * @calls extractInputFieldsFromExpression - To extract columns with GROUP_BY transformation
 */
function getGroupByLineage(select: Select, namespace: Namespace): InputField[] {
  if (!select.groupby) return [];

  // Normalize GROUP BY to array format
  const groupByItems = normalizeGroupByItems(select.groupby);
  const { regularTables } = getTableExpressionsFromSelect(select);

  return groupByItems.flatMap((expr) =>
    extractInputFieldsFromExpression(expr, regularTables, namespace, INDIRECT_GROUP_BY),
  );
}

/**
 * Normalizes GROUP BY clause to a consistent array format.
 * Handles different AST representations from various SQL parsers.
 * @returns Array of ExpressionValue for each GROUP BY item
 */
function normalizeGroupByItems(groupby: Select["groupby"]): ExpressionValue[] {
  if (Array.isArray(groupby)) {
    return groupby;
  }
  if (typeof groupby === "object" && groupby && "columns" in groupby && Array.isArray(groupby.columns)) {
    return groupby.columns;
  }
  return [groupby as unknown as ExpressionValue];
}

/**
 * Builds a map of output column aliases to their source expressions.
 * Used to resolve ORDER BY alias references to their underlying columns.
 * @returns Map where keys are output aliases, values are the source expressions
 *
 * @calls isColumn - To filter valid columns
 * @calls getOutputColumnName - To get the alias/output name
 */
function buildAliasToExpressionMap(select: Select): Map<string, ExpressionValue> {
  const aliasMap = new Map<string, ExpressionValue>();

  if (!select.columns || typeof select.columns === "string") {
    return aliasMap;
  }

  select.columns.forEach((col) => {
    if (!isColumn(col)) return;

    const outputName = getOutputColumnName(col);
    if (outputName && col.expr) {
      aliasMap.set(outputName, col.expr);
    }
  });

  return aliasMap;
}

/**
 * Resolves an ORDER BY expression to its underlying column reference.
 * If the expression is an alias (unqualified column_ref matching an alias), returns the aliased expression.
 * @returns The resolved expression (original if not an alias, or the aliased expression)
 *
 * @calls getInputColumnName - To extract column name from column_ref
 */
function resolveOrderByExpression(expr: ExpressionValue, aliasMap: Map<string, ExpressionValue>): ExpressionValue {
  // If it's a column_ref, check if it's an alias
  if (expr.type === "column_ref") {
    const colRef = expr as ColumnRefItem;
    const columnName = getInputColumnName(colRef);

    // Only resolve if there's no table qualifier (aliases don't have table qualifiers)
    if (columnName && !colRef.table && aliasMap.has(columnName)) {
      return aliasMap.get(columnName)!;
    }
  }

  return expr;
}

/**
 * Extracts ORDER BY clause lineage with alias resolution.
 * All columns in ORDER BY receive INDIRECT/SORT transformation.
 * Resolves aliases to their underlying column expressions.
 * @returns Array of InputFields for columns used in ORDER BY clause
 *
 * @calls getTableExpressionsFromSelect - To get regular tables from FROM
 * @calls buildAliasToExpressionMap - To resolve aliases
 * @calls resolveOrderByExpression - To resolve each ORDER BY item
 * @calls extractInputFieldsFromExpression - To extract columns with SORT transformation
 */
function getOrderByLineage(select: Select, namespace: Namespace): InputField[] {
  if (!select.orderby) return [];

  const orderByItems = Array.isArray(select.orderby) ? select.orderby : [select.orderby];
  const { regularTables } = getTableExpressionsFromSelect(select);

  // Build alias map to resolve ORDER BY alias references
  const aliasMap = buildAliasToExpressionMap(select);

  const inputFields: InputField[] = [];

  orderByItems.forEach((item) => {
    const expr = ("expr" in item ? item.expr : item) as ExpressionValue;

    // Resolve the expression - if it's an alias, get the underlying expression
    const resolvedExpr = resolveOrderByExpression(expr, aliasMap);

    // Extract input fields from the resolved expression
    inputFields.push(...extractInputFieldsFromExpression(resolvedExpr, regularTables, namespace, INDIRECT_SORT));
  });

  return inputFields;
}

/**
 * Extracts WINDOW function lineage from SELECT columns.
 * Columns in PARTITION BY and ORDER BY clauses of OVER receive INDIRECT/WINDOW transformation.
 * @returns Array of InputFields for columns used in window function OVER clauses
 *
 * @calls getTableExpressionsFromSelect - To get regular tables from FROM
 * @calls isColumn - To filter valid columns
 * @calls extractWindowExpressions - To get OVER clause expressions
 * @calls extractInputFieldsFromExpression - To extract columns with WINDOW transformation
 */
function getWindowLineage(select: Select, namespace: Namespace): InputField[] {
  if (!select.columns || (typeof select.columns === "string" && select.columns === "*")) {
    return [];
  }

  const { regularTables } = getTableExpressionsFromSelect(select);
  const inputFields: InputField[] = [];

  for (const col of select.columns) {
    if (!isColumn(col)) continue;

    const windowExprs = extractWindowExpressions(col.expr);
    inputFields.push(
      ...windowExprs.flatMap((expr) =>
        extractInputFieldsFromExpression(expr, regularTables, namespace, INDIRECT_WINDOW),
      ),
    );
  }

  return inputFields;
}

/**
 * Extracts PARTITION BY and ORDER BY expressions from a window function expression.
 * Supports both aggr_func (SUM() OVER) and function types (ROW_NUMBER() OVER).
 * @returns Array of expressions from the OVER clause, empty if not a window function
 *
 * @calls extractWindowExpressionsFromOver - To parse the OVER clause structure
 */
function extractWindowExpressions(expr: ExpressionValue): ExpressionValue[] {
  // Support both aggr_func and function types with OVER clause
  if ((expr.type !== "aggr_func" && expr.type !== "function") || !("over" in expr)) return [];

  const exprWithOver = expr as (AggrFunc | AstFunction) & { over?: OverClause };

  if (!exprWithOver.over) return [];

  return extractWindowExpressionsFromOver(exprWithOver.over);
}

/**
 * Extracts HAVING clause lineage.
 * All columns in HAVING conditions receive INDIRECT/FILTER transformation.
 * @returns Array of InputFields for columns used in HAVING clause
 *
 * @calls getTableExpressionsFromSelect - To get regular tables from FROM
 * @calls extractInputFieldsFromExpression - To extract columns with FILTER transformation
 */
function getHavingLineage(select: Select, namespace: Namespace): InputField[] {
  if (!select.having) return [];

  const { regularTables } = getTableExpressionsFromSelect(select);
  return extractInputFieldsFromExpression(
    select.having as unknown as ExpressionValue,
    regularTables,
    namespace,
    INDIRECT_FILTER,
  );
}

/**
 * Extracts and categorizes table expressions from a SELECT statement.
 * Separates regular tables (physical tables) from select tables (CTEs, subqueries).
 * @returns Object with:
 *   - regularTables: Physical tables from namespace
 *   - selectTables: CTEs and subqueries (as SelectWithAlias)
 */
function getTableExpressionsFromSelect(select: Select): {
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

/**
 * Merges two TransformationSets by combining each parent transformation with each child.
 * Creates a Cartesian product of transformations, merging each pair.
 * @returns New TransformationSet with all merged combinations
 *
 * @calls mergeTransformations - To merge each parent-child pair
 */
function mergeTransformationSet(parent: TransformationSet, child: TransformationSet): TransformationSet {
  const merged = new TransformationSet();

  parent.forEach((tp) => {
    child.forEach((tc) => {
      merged.add(mergeTransformations(tp, tc));
    });
  });

  return merged;
}

/**
 * Expands a star (wildcard) column into individual column entries.
 * Handles both "*" (all tables) and "table.*" (specific table) patterns.
 * @returns Array of AstColumn entries for each expanded column
 *
 * @calls isStar - To verify it's a star column
 * @calls getStarTableQualifier - To get table qualifier if present
 * @calls getTableExpressionsFromSelect - To get tables from FROM clause
 * @calls astTableMatchesSchemaTable - To match tables to namespace
 * @calls expandStarColumn - Recursively for nested star expressions in subqueries
 * @calls getOutputColumnName - To get column names from subquery columns
 */
function expandStarColumn(column: AstColumn, select: Select, namespace: Namespace): AstColumn[] {
  if (!isStar(column)) return [column];
  if (!namespace.tables) return [column];

  const tableQualifier = getStarTableQualifier(column);
  const { regularTables, selectTables } = getTableExpressionsFromSelect(select);
  const expandedColumns: AstColumn[] = [];

  // Process regular tables (from namespace)
  regularTables.forEach((fromTable) => {
    // If there's a table qualifier, skip tables that don't match
    if (tableQualifier && tableQualifier !== fromTable.table && tableQualifier !== fromTable.as) {
      return;
    }

    const schemaTable = namespace.tables!.find((t) =>
      astTableMatchesSchemaTable(fromTable, t.name, namespace.defaultSchema),
    );
    if (!schemaTable) return;

    for (const colName of schemaTable.columns) {
      expandedColumns.push({
        expr: {
          type: "column_ref",
          table: fromTable.as ?? fromTable.table,
          column: colName,
        } as ExpressionValue,
        as: colName,
      });
    }
  });

  // Process subquery/CTE tables
  selectTables.forEach((selectTable) => {
    // If there's a table qualifier, skip tables that don't match
    if (tableQualifier && tableQualifier !== selectTable.as) {
      return;
    }

    // Get columns from the subquery/CTE
    if (selectTable.columns && typeof selectTable.columns !== "string") {
      selectTable.columns.forEach((subCol) => {
        if (!isColumn(subCol)) return;

        // Handle star in subquery recursively
        if (isStar(subCol)) {
          const expandedSubCols = expandStarColumn(subCol, selectTable, namespace);
          expandedSubCols.forEach((expandedSubCol) => {
            const outputName = getOutputColumnName(expandedSubCol);
            if (outputName) {
              expandedColumns.push({
                expr: {
                  type: "column_ref",
                  table: selectTable.as ?? null,
                  column: outputName,
                } as unknown as ExpressionValue,
                as: outputName,
              });
            }
          });
        } else {
          const outputName = getOutputColumnName(subCol);
          if (outputName) {
            expandedColumns.push({
              expr: {
                type: "column_ref",
                table: selectTable.as ?? null,
                column: outputName,
              } as unknown as ExpressionValue,
              as: outputName,
            });
          }
        }
      });
    }
  });

  return expandedColumns;
}

/**
 * Type guard to check if a SELECT has set operations (UNION, INTERSECT, EXCEPT).
 * @returns True if the SELECT has a set_op property with a value
 */
function hasSetOperation(select: Select): select is Select {
  return "set_op" in select && select.set_op != null;
}

/**
 * Collects all SELECT statements in a set operation chain.
 * Follows the _next chain for UNION/INTERSECT/EXCEPT operations.
 * @returns Array of SELECT statements, first element is the base select
 *
 * @calls hasSetOperation - To check if there are more SELECTs in the chain
 */
function getSetOperationSelects(select: Select): Select[] {
  const selects: Select[] = [select];

  if (hasSetOperation(select)) {
    let current: Select | undefined | null = select._next;
    while (current) {
      selects.push(current);
      current = hasSetOperation(current) ? current._next : null;
    }
  }

  return selects;
}

/**
 * Computes field-level lineage for a single output column.
 * Traces the column back to its source columns in the namespace tables.
 *
 * Process:
 * 1. Extracts transformations from the column expression
 * 2. Merges with any parent transformations (for nested queries)
 * 3. Resolves each column reference to InputField via regular tables or recursion into CTEs/subqueries
 * @returns Array of InputField objects representing source columns with transformations
 *
 * @calls extractTransformationsFromExpr - To get column transformations from expression
 * @calls mergeTransformationSet - To combine with parent transformations
 * @calls getTableExpressionsFromSelect - To separate regular tables from CTEs/subqueries
 * @calls parseInputColumnName - To parse column identifiers
 * @calls astTableMatchesSchemaTable - To match columns to namespace tables
 * @calls getColumnLineage - Recursively for columns from CTEs/subqueries
 */
export function getColumnLineage(
  select: Select,
  namespace: Namespace,
  column: AstColumn,
  transformations?: TransformationSet,
): InputField[] {
  let transformationsByColumns = extractTransformationsFromExpr(column.expr);

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

  if (!namespace.tables) return inputFields;

  for (const [inputColumnName, transformations] of Object.entries(transformationsByColumns)) {
    const inputColumn = parseInputColumnName(inputColumnName);

    const table = regularTables.find(
      (t) =>
        (!inputColumn.table || inputColumn.table === t.table || inputColumn.table === t.as) &&
        namespace.tables!.some(
          (s) => astTableMatchesSchemaTable(t, s.name, namespace.defaultSchema) && s.columns.includes(inputColumn.name),
        ),
    );

    if (table) {
      const schemaTable = namespace.tables.find((s) =>
        astTableMatchesSchemaTable(table, s.name, namespace.defaultSchema),
      );
      inputFields.push({
        namespace: namespace.namespace,
        name: schemaTable!.name,
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

        inputFields.push(...getColumnLineage(selectTable, namespace, nextColumn, transformations));
      }
    }
  }

  return inputFields;
}

/**
 * Extracts dataset-level indirect lineage for a single SELECT statement.
 * Collects all columns that affect the entire result set through indirect transformations.
 * @returns Array of InputFields for all indirect lineage columns
 *
 * @calls getJoinLineage, getFilterLineage, getGroupByLineage, getOrderByLineage,
 *        getWindowLineage, getHavingLineage - To collect each type of indirect lineage
 * @calls getTableExpressionsFromSelect - To find CTEs/subqueries
 * @calls getDatasetLineage - Recursively for CTEs/subqueries
 */
function getDatasetLineageForSingleSelect(select: Select, namespace: Namespace): InputField[] {
  const allIndirectFields: InputField[] = [];

  // Collect all indirect lineage from the outermost SELECT
  allIndirectFields.push(...getJoinLineage(select, namespace));
  allIndirectFields.push(...getFilterLineage(select, namespace));
  allIndirectFields.push(...getGroupByLineage(select, namespace));
  allIndirectFields.push(...getOrderByLineage(select, namespace));
  allIndirectFields.push(...getWindowLineage(select, namespace));
  allIndirectFields.push(...getHavingLineage(select, namespace));

  // Recursively collect dataset lineage from CTEs and subqueries
  const { selectTables } = getTableExpressionsFromSelect(select);
  for (const selectTable of selectTables) {
    allIndirectFields.push(...getDatasetLineage(selectTable, namespace));
  }

  return allIndirectFields;
}

/**
 * Computes all dataset-level indirect lineage for a SELECT, including set operations.
 * Returns columns that affect the entire result set (not mapped to specific output columns).
 * @returns Deduplicated array of InputFields for dataset-level lineage
 *
 * @calls getSetOperationSelects - To collect all SELECTs in set operation chain
 * @calls getDatasetLineageForSingleSelect - To get lineage for each SELECT
 */
export function getDatasetLineage(select: Select, namespace: Namespace): InputField[] {
  const allIndirectFields: InputField[] = [];

  // Handle set operations (UNION, INTERSECT, EXCEPT)
  const setOpSelects = getSetOperationSelects(select);
  setOpSelects.forEach((setOpSelect) => {
    allIndirectFields.push(...getDatasetLineageForSingleSelect(setOpSelect, namespace));
  });

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
 * Computes field-level lineage for a single SELECT (without set operations).
 * Maps each output column to its source columns with transformations.
 * @returns Object mapping output column names to their FieldLineage (inputFields array)
 *
 * @calls isColumn - To filter valid columns
 * @calls isStar - To detect wildcard columns
 * @calls expandStarColumn - To expand * into individual columns
 * @calls getOutputColumnName - To determine output column name
 * @calls getColumnLineage - To compute lineage for each column
 */
function getLineageForSingleSelect(select: Select, namespace: Namespace): ColumnLineageDatasetFacet["fields"] {
  let unknownCount = 0;

  // Handle the case where columns is the string "*" (entire result is star)
  if (typeof select.columns === "string" && select.columns === "*") {
    return {};
  }

  return select.columns.reduce(
    (acc, column) => {
      if (!isColumn(column)) {
        return acc;
      }

      // Expand star columns into individual columns
      if (isStar(column)) {
        const expandedColumns = expandStarColumn(column, select, namespace);
        expandedColumns.forEach((expandedCol) => {
          let outputFieldName = getOutputColumnName(expandedCol);
          if (!outputFieldName) {
            outputFieldName = `unknown_${unknownCount++}`;
          }
          acc[outputFieldName] = { inputFields: getColumnLineage(select, namespace, expandedCol) };
        });

        return acc;
      }

      let outputFieldName = getOutputColumnName(column);

      if (!outputFieldName) {
        outputFieldName = `unknown_${unknownCount++}`;
      }

      acc[outputFieldName] = { inputFields: getColumnLineage(select, namespace, column) };
      return acc;
    },
    {} as ColumnLineageDatasetFacet["fields"],
  );
}

/**
 * Merges and deduplicates InputField arrays.
 * Used when combining lineage from multiple sources (e.g., UNION branches).
 * @returns Combined array with duplicates removed
 *
 * @calls transformationHasher - To create unique keys for transformations
 */
function mergeInputFields(existing: InputField[], incoming: InputField[]): InputField[] {
  const hashset = new HashSet((value: InputField) => {
    const transformationsString =
      value.transformations?.map((t) => transformationHasher(t as Transformation)).join("-") ?? "";
    return `${value.namespace}-${value.name}-${value.field}-${transformationsString}`;
  });
  existing.forEach((field) => hashset.add(field));
  incoming.forEach((field) => hashset.add(field));

  return [...hashset.values()];
}

/**
 * Main field-level lineage extraction function.
 * Returns a map of output columns to their source columns with transformations.
 *
 * Handles set operations (UNION, INTERSECT, EXCEPT) by:
 * 1. Using the first SELECT's column names as output names
 * 2. Merging lineage from subsequent SELECTs by column position
 * @returns Object mapping output column names to FieldLineage objects
 *
 * @calls getSetOperationSelects - To collect all SELECTs in chain
 * @calls getLineageForSingleSelect - To compute lineage for each SELECT
 * @calls mergeInputFields - To combine lineage from set operation branches
 */
export function getLineage(select: Select, namespace: Namespace): ColumnLineageDatasetFacet["fields"] {
  // Get all SELECT statements in the set operation chain
  const setOpSelects = getSetOperationSelects(select);

  // Get lineage from the first SELECT (determines output column names)
  const baseLineage = getLineageForSingleSelect(setOpSelects[0]!, namespace);

  // If no set operations, return base lineage
  if (setOpSelects.length === 1) {
    return baseLineage;
  }

  // Merge lineages from subsequent SELECTs in the set operation
  // Output columns are matched by position, not name
  const baseColumns = Object.keys(baseLineage);

  for (let i = 1; i < setOpSelects.length; i++) {
    const nextSelect = setOpSelects[i]!;
    const nextLineage = getLineageForSingleSelect(nextSelect, namespace);
    const nextColumns = Object.keys(nextLineage);

    // Match columns by position and merge input fields
    for (let j = 0; j < baseColumns.length && j < nextColumns.length; j++) {
      const baseCol = baseColumns[j]!;
      const nextCol = nextColumns[j]!;

      if (baseLineage[baseCol] && nextLineage[nextCol]) {
        baseLineage[baseCol]!.inputFields = mergeInputFields(
          baseLineage[baseCol]!.inputFields,
          nextLineage[nextCol]!.inputFields,
        );
      }
    }
  }

  return baseLineage;
}

/**
 * Extended lineage extraction returning both field-level and dataset-level lineage.
 * Follows the OpenLineage ColumnLineageDatasetFacet specification.
 */
export function getExtendedLineage(
  select: Select,
  namespace: Namespace,
): Pick<ColumnLineageDatasetFacet, "fields" | "dataset"> {
  return {
    fields: getLineage(select, namespace),
    dataset: getDatasetLineage(select, namespace),
  };
}

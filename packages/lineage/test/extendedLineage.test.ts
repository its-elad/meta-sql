import { describe, test, expect } from "bun:test";
import { Parser } from "node-sql-parser";
import type { AST, Select } from "node-sql-parser";
import {
  getExtendedLineage,
  type Namespace,
  type Table,
  INDIRECT_JOIN,
  INDIRECT_FILTER,
  INDIRECT_GROUP_BY,
  INDIRECT_SORT,
  INDIRECT_WINDOW,
  INDIRECT_CONDITION,
  DIRECT_IDENTITY,
  DIRECT_TRANSFORMATION,
  DIRECT_AGGREGATION,
} from "../src/index.js";

const DEFAULT_SCHEMA = "public";

const parser = new Parser();

function createNamespace(namespace: string, tables: Table[], defaultSchema: string = DEFAULT_SCHEMA): Namespace {
  return { namespace, tables, defaultSchema };
}

function createTable(name: string, columns: string[]): Table {
  return { name, columns };
}

function parseSQL(sql: string, database: "trino" | "postgresql" = "trino"): AST {
  const result = parser.astify(sql, { database });
  const ast = Array.isArray(result) ? result[0] : result;
  if (!ast) throw new Error("Failed to parse SQL");
  return ast;
}

function parseSQLPostgres(sql: string): AST {
  const result = parser.astify(sql, { database: "postgresql" });
  const ast = Array.isArray(result) ? result[0] : result;
  if (!ast) throw new Error("Failed to parse SQL");
  return ast;
}

// =============================================================================
// EXACT ASSERTION HELPERS
// =============================================================================

/** Sort input fields for consistent comparison */
function sortInputFields(fields: ReturnType<typeof getExtendedLineage>["fields"]) {
  const sorted: typeof fields = {};
  for (const [key, value] of Object.entries(fields)) {
    sorted[key] = {
      inputFields: [...value.inputFields].sort((a, b) => {
        const aKey = `${a.namespace}.${a.name}.${a.field}`;
        const bKey = `${b.namespace}.${b.name}.${b.field}`;
        return aKey.localeCompare(bKey);
      }),
    };
  }
  return sorted;
}

/** Sort dataset fields for consistent comparison */
function sortDataset(dataset: ReturnType<typeof getExtendedLineage>["dataset"]) {
  if (!dataset) return [];
  return [...dataset].sort((a, b) => {
    const aKey = `${a.namespace}.${a.name}.${a.field}.${a.transformations?.[0]?.subtype}`;
    const bKey = `${b.namespace}.${b.name}.${b.field}.${b.transformations?.[0]?.subtype}`;
    return aKey.localeCompare(bKey);
  });
}

// =============================================================================
// SECTION 1: FIELD-LEVEL LINEAGE - DIRECT TRANSFORMATIONS
// =============================================================================

describe("Field-Level Lineage: DIRECT/IDENTITY", () => {
  test("single column select", () => {
    const sql = `SELECT id FROM users`;
    const ast = parseSQL(sql);
    const schema = createNamespace("ns", [createTable(`${DEFAULT_SCHEMA}.users`, ["id"])]);
    const result = getExtendedLineage(ast as Select, schema);

    expect(result.fields).toEqual({
      id: {
        inputFields: [
          { namespace: "ns", name: `${DEFAULT_SCHEMA}.users`, field: "id", transformations: [DIRECT_IDENTITY] },
        ],
      },
    });
    expect(result.dataset).toEqual([]);
  });

  test("multiple columns select", () => {
    const sql = `SELECT id, name, email FROM users`;
    const ast = parseSQL(sql);
    const schema = createNamespace("ns", [createTable(`${DEFAULT_SCHEMA}.users`, ["id", "name", "email"])]);
    const result = getExtendedLineage(ast as Select, schema);

    expect(result.fields).toEqual({
      id: {
        inputFields: [
          { namespace: "ns", name: `${DEFAULT_SCHEMA}.users`, field: "id", transformations: [DIRECT_IDENTITY] },
        ],
      },
      name: {
        inputFields: [
          { namespace: "ns", name: `${DEFAULT_SCHEMA}.users`, field: "name", transformations: [DIRECT_IDENTITY] },
        ],
      },
      email: {
        inputFields: [
          { namespace: "ns", name: `${DEFAULT_SCHEMA}.users`, field: "email", transformations: [DIRECT_IDENTITY] },
        ],
      },
    });
    expect(result.dataset).toEqual([]);
  });

  test("column with alias", () => {
    const sql = `SELECT id as user_id, name as user_name FROM users`;
    const ast = parseSQL(sql);
    const schema = createNamespace("ns", [createTable(`${DEFAULT_SCHEMA}.users`, ["id", "name"])]);
    const result = getExtendedLineage(ast as Select, schema);

    expect(result.fields).toEqual({
      user_id: {
        inputFields: [
          { namespace: "ns", name: `${DEFAULT_SCHEMA}.users`, field: "id", transformations: [DIRECT_IDENTITY] },
        ],
      },
      user_name: {
        inputFields: [
          { namespace: "ns", name: `${DEFAULT_SCHEMA}.users`, field: "name", transformations: [DIRECT_IDENTITY] },
        ],
      },
    });
  });

  test("table-qualified column", () => {
    const sql = `SELECT u.id, u.name FROM users u`;
    const ast = parseSQL(sql);
    const schema = createNamespace("ns", [createTable(`${DEFAULT_SCHEMA}.users`, ["id", "name"])]);
    const result = getExtendedLineage(ast as Select, schema);

    expect(result.fields).toEqual({
      id: {
        inputFields: [
          { namespace: "ns", name: `${DEFAULT_SCHEMA}.users`, field: "id", transformations: [DIRECT_IDENTITY] },
        ],
      },
      name: {
        inputFields: [
          { namespace: "ns", name: `${DEFAULT_SCHEMA}.users`, field: "name", transformations: [DIRECT_IDENTITY] },
        ],
      },
    });
  });
});

describe("Field-Level Lineage: DIRECT/TRANSFORMATION", () => {
  test("function transformation - UPPER", () => {
    const sql = `SELECT UPPER(name) as upper_name FROM users`;
    const ast = parseSQL(sql);
    const schema = createNamespace("ns", [createTable(`${DEFAULT_SCHEMA}.users`, ["name"])]);
    const result = getExtendedLineage(ast as Select, schema);

    expect(result.fields).toEqual({
      upper_name: {
        inputFields: [
          { namespace: "ns", name: `${DEFAULT_SCHEMA}.users`, field: "name", transformations: [DIRECT_TRANSFORMATION] },
        ],
      },
    });
  });

  test("function transformation - CONCAT", () => {
    const sql = `SELECT CONCAT(first_name, last_name) as full_name FROM users`;
    const ast = parseSQL(sql);
    const schema = createNamespace("ns", [createTable(`${DEFAULT_SCHEMA}.users`, ["first_name", "last_name"])]);
    const result = getExtendedLineage(ast as Select, schema);

    expect(sortInputFields(result.fields)).toEqual(
      sortInputFields({
        full_name: {
          inputFields: [
            {
              namespace: "ns",
              name: `${DEFAULT_SCHEMA}.users`,
              field: "first_name",
              transformations: [DIRECT_TRANSFORMATION],
            },
            {
              namespace: "ns",
              name: `${DEFAULT_SCHEMA}.users`,
              field: "last_name",
              transformations: [DIRECT_TRANSFORMATION],
            },
          ],
        },
      }),
    );
  });

  test("arithmetic transformation - addition", () => {
    const sql = `SELECT price + tax as total FROM products`;
    const ast = parseSQL(sql);
    const schema = createNamespace("ns", [createTable(`${DEFAULT_SCHEMA}.products`, ["price", "tax"])]);
    const result = getExtendedLineage(ast as Select, schema);

    expect(sortInputFields(result.fields)).toEqual(
      sortInputFields({
        total: {
          inputFields: [
            {
              namespace: "ns",
              name: `${DEFAULT_SCHEMA}.products`,
              field: "price",
              transformations: [DIRECT_TRANSFORMATION],
            },
            {
              namespace: "ns",
              name: `${DEFAULT_SCHEMA}.products`,
              field: "tax",
              transformations: [DIRECT_TRANSFORMATION],
            },
          ],
        },
      }),
    );
  });

  test("arithmetic transformation - multiplication", () => {
    const sql = `SELECT quantity * unit_price as line_total FROM order_items`;
    const ast = parseSQL(sql);
    const schema = createNamespace("ns", [createTable(`${DEFAULT_SCHEMA}.order_items`, ["quantity", "unit_price"])]);
    const result = getExtendedLineage(ast as Select, schema);

    expect(sortInputFields(result.fields)).toEqual(
      sortInputFields({
        line_total: {
          inputFields: [
            {
              namespace: "ns",
              name: `${DEFAULT_SCHEMA}.order_items`,
              field: "quantity",
              transformations: [DIRECT_TRANSFORMATION],
            },
            {
              namespace: "ns",
              name: `${DEFAULT_SCHEMA}.order_items`,
              field: "unit_price",
              transformations: [DIRECT_TRANSFORMATION],
            },
          ],
        },
      }),
    );
  });

  test("CAST transformation", () => {
    const sql = `SELECT CAST(price AS VARCHAR) as price_str FROM products`;
    const ast = parseSQL(sql);
    const schema = createNamespace("ns", [createTable(`${DEFAULT_SCHEMA}.products`, ["price"])]);
    const result = getExtendedLineage(ast as Select, schema);

    expect(result.fields).toEqual({
      price_str: {
        inputFields: [
          {
            namespace: "ns",
            name: `${DEFAULT_SCHEMA}.products`,
            field: "price",
            transformations: [DIRECT_TRANSFORMATION],
          },
        ],
      },
    });
  });

  test("nested function transformation", () => {
    const sql = `SELECT LOWER(TRIM(name)) as clean_name FROM users`;
    const ast = parseSQL(sql);
    const schema = createNamespace("ns", [createTable(`${DEFAULT_SCHEMA}.users`, ["name"])]);
    const result = getExtendedLineage(ast as Select, schema);

    expect(result.fields).toEqual({
      clean_name: {
        inputFields: [
          { namespace: "ns", name: `${DEFAULT_SCHEMA}.users`, field: "name", transformations: [DIRECT_TRANSFORMATION] },
        ],
      },
    });
  });
});

describe("Field-Level Lineage: DIRECT/AGGREGATION", () => {
  test("SUM aggregation", () => {
    const sql = `SELECT SUM(amount) as total FROM transactions`;
    const ast = parseSQL(sql);
    const schema = createNamespace("ns", [createTable(`${DEFAULT_SCHEMA}.transactions`, ["amount"])]);
    const result = getExtendedLineage(ast as Select, schema);

    expect(result.fields).toEqual({
      total: {
        inputFields: [
          {
            namespace: "ns",
            name: `${DEFAULT_SCHEMA}.transactions`,
            field: "amount",
            transformations: [DIRECT_AGGREGATION],
          },
        ],
      },
    });
  });

  test("AVG aggregation", () => {
    const sql = `SELECT AVG(salary) as avg_salary FROM employees`;
    const ast = parseSQL(sql);
    const schema = createNamespace("ns", [createTable(`${DEFAULT_SCHEMA}.employees`, ["salary"])]);
    const result = getExtendedLineage(ast as Select, schema);

    expect(result.fields).toEqual({
      avg_salary: {
        inputFields: [
          {
            namespace: "ns",
            name: `${DEFAULT_SCHEMA}.employees`,
            field: "salary",
            transformations: [DIRECT_AGGREGATION],
          },
        ],
      },
    });
  });

  test("MIN aggregation", () => {
    const sql = `SELECT MIN(price) as min_price FROM products`;
    const ast = parseSQL(sql);
    const schema = createNamespace("ns", [createTable(`${DEFAULT_SCHEMA}.products`, ["price"])]);
    const result = getExtendedLineage(ast as Select, schema);

    expect(result.fields).toEqual({
      min_price: {
        inputFields: [
          {
            namespace: "ns",
            name: `${DEFAULT_SCHEMA}.products`,
            field: "price",
            transformations: [DIRECT_AGGREGATION],
          },
        ],
      },
    });
  });

  test("MAX aggregation", () => {
    const sql = `SELECT MAX(created_at) as latest FROM events`;
    const ast = parseSQL(sql);
    const schema = createNamespace("ns", [createTable(`${DEFAULT_SCHEMA}.events`, ["created_at"])]);
    const result = getExtendedLineage(ast as Select, schema);

    expect(result.fields).toEqual({
      latest: {
        inputFields: [
          {
            namespace: "ns",
            name: `${DEFAULT_SCHEMA}.events`,
            field: "created_at",
            transformations: [DIRECT_AGGREGATION],
          },
        ],
      },
    });
  });

  test("COUNT with column - has masking", () => {
    const sql = `SELECT COUNT(id) as count FROM users`;
    const ast = parseSQL(sql);
    const schema = createNamespace("ns", [createTable(`${DEFAULT_SCHEMA}.users`, ["id"])]);
    const result = getExtendedLineage(ast as Select, schema);

    expect(result.fields).toEqual({
      count: {
        inputFields: [
          {
            namespace: "ns",
            name: `${DEFAULT_SCHEMA}.users`,
            field: "id",
            transformations: [{ type: "DIRECT", subtype: "AGGREGATION", masking: true }],
          },
        ],
      },
    });
  });

  test("COUNT DISTINCT - has masking", () => {
    const sql = `SELECT COUNT(DISTINCT user_id) as unique_users FROM orders`;
    const ast = parseSQL(sql);
    const schema = createNamespace("ns", [createTable(`${DEFAULT_SCHEMA}.orders`, ["user_id"])]);
    const result = getExtendedLineage(ast as Select, schema);

    expect(result.fields).toEqual({
      unique_users: {
        inputFields: [
          {
            namespace: "ns",
            name: `${DEFAULT_SCHEMA}.orders`,
            field: "user_id",
            transformations: [{ type: "DIRECT", subtype: "AGGREGATION", masking: true }],
          },
        ],
      },
    });
  });

  test("aggregation with expression inside", () => {
    const sql = `SELECT SUM(quantity * price) as revenue FROM order_items`;
    const ast = parseSQL(sql);
    const schema = createNamespace("ns", [createTable(`${DEFAULT_SCHEMA}.order_items`, ["quantity", "price"])]);
    const result = getExtendedLineage(ast as Select, schema);

    expect(sortInputFields(result.fields)).toEqual(
      sortInputFields({
        revenue: {
          inputFields: [
            {
              namespace: "ns",
              name: `${DEFAULT_SCHEMA}.order_items`,
              field: "price",
              transformations: [DIRECT_AGGREGATION],
            },
            {
              namespace: "ns",
              name: `${DEFAULT_SCHEMA}.order_items`,
              field: "quantity",
              transformations: [DIRECT_AGGREGATION],
            },
          ],
        },
      }),
    );
  });
});

describe("Field-Level Lineage: Masking Functions", () => {
  test("MD5 masking", () => {
    const sql = `SELECT MD5(email) as hashed_email FROM users`;
    const ast = parseSQL(sql);
    const schema = createNamespace("ns", [createTable(`${DEFAULT_SCHEMA}.users`, ["email"])]);
    const result = getExtendedLineage(ast as Select, schema);

    expect(result.fields).toEqual({
      hashed_email: {
        inputFields: [
          {
            namespace: "ns",
            name: `${DEFAULT_SCHEMA}.users`,
            field: "email",
            transformations: [{ type: "DIRECT", subtype: "TRANSFORMATION", masking: true }],
          },
        ],
      },
    });
  });

  test("SHA256 masking", () => {
    const sql = `SELECT SHA256(ssn) as hashed_ssn FROM employees`;
    const ast = parseSQL(sql);
    const schema = createNamespace("ns", [createTable(`${DEFAULT_SCHEMA}.employees`, ["ssn"])]);
    const result = getExtendedLineage(ast as Select, schema);

    expect(result.fields).toEqual({
      hashed_ssn: {
        inputFields: [
          {
            namespace: "ns",
            name: `${DEFAULT_SCHEMA}.employees`,
            field: "ssn",
            transformations: [{ type: "DIRECT", subtype: "TRANSFORMATION", masking: true }],
          },
        ],
      },
    });
  });

  test("MASK function", () => {
    const sql = `SELECT MASK(phone) as masked_phone FROM contacts`;
    const ast = parseSQL(sql);
    const schema = createNamespace("ns", [createTable(`${DEFAULT_SCHEMA}.contacts`, ["phone"])]);
    const result = getExtendedLineage(ast as Select, schema);

    expect(result.fields).toEqual({
      masked_phone: {
        inputFields: [
          {
            namespace: "ns",
            name: `${DEFAULT_SCHEMA}.contacts`,
            field: "phone",
            transformations: [{ type: "DIRECT", subtype: "TRANSFORMATION", masking: true }],
          },
        ],
      },
    });
  });
});

describe("Field-Level Lineage: CASE Expressions", () => {
  test("simple CASE WHEN", () => {
    const sql = `
      SELECT 
        CASE WHEN status = 'active' THEN 'Active' ELSE 'Inactive' END as status_label
      FROM users
    `;
    const ast = parseSQL(sql);
    const schema = createNamespace("ns", [createTable(`${DEFAULT_SCHEMA}.users`, ["status"])]);
    const result = getExtendedLineage(ast as Select, schema);

    // CASE WHEN condition column gets INDIRECT/CONDITION
    expect(result.fields.status_label).toBeDefined();
    expect(result.fields.status_label?.inputFields).toEqual([
      {
        namespace: "ns",
        name: `${DEFAULT_SCHEMA}.users`,
        field: "status",
        transformations: [INDIRECT_CONDITION],
      },
    ]);
  });

  test("CASE with column in result", () => {
    const sql = `
      SELECT 
        CASE WHEN is_premium THEN discount_rate ELSE 0 END as applied_discount
      FROM customers
    `;
    const ast = parseSQL(sql);
    const schema = createNamespace("ns", [createTable(`${DEFAULT_SCHEMA}.customers`, ["is_premium", "discount_rate"])]);
    const result = getExtendedLineage(ast as Select, schema);

    expect(sortInputFields(result.fields)).toEqual(
      sortInputFields({
        applied_discount: {
          inputFields: [
            {
              namespace: "ns",
              name: `${DEFAULT_SCHEMA}.customers`,
              field: "is_premium",
              transformations: [INDIRECT_CONDITION],
            },
            {
              namespace: "ns",
              name: `${DEFAULT_SCHEMA}.customers`,
              field: "discount_rate",
              transformations: [DIRECT_IDENTITY],
            },
          ],
        },
      }),
    );
  });

  test("CASE with multiple conditions and results", () => {
    const sql = `
      SELECT 
        CASE 
          WHEN age < 18 THEN minor_price
          WHEN age < 65 THEN adult_price
          ELSE senior_price
        END as ticket_price
      FROM visitors
    `;
    const ast = parseSQL(sql);
    const schema = createNamespace("ns", [
      createTable(`${DEFAULT_SCHEMA}.visitors`, ["age", "minor_price", "adult_price", "senior_price"]),
    ]);
    const result = getExtendedLineage(ast as Select, schema);

    expect(sortInputFields(result.fields)).toEqual(
      sortInputFields({
        ticket_price: {
          inputFields: [
            {
              field: "age",
              name: `${DEFAULT_SCHEMA}.visitors`,
              namespace: "ns",
              transformations: [INDIRECT_CONDITION],
            },
            {
              field: "minor_price",
              name: `${DEFAULT_SCHEMA}.visitors`,
              namespace: "ns",
              transformations: [DIRECT_IDENTITY],
            },
            {
              field: "adult_price",
              name: `${DEFAULT_SCHEMA}.visitors`,
              namespace: "ns",
              transformations: [DIRECT_IDENTITY],
            },
            {
              field: "senior_price",
              name: `${DEFAULT_SCHEMA}.visitors`,
              namespace: "ns",
              transformations: [DIRECT_IDENTITY],
            },
          ],
        },
      }),
    );
  });
});

// =============================================================================
// SECTION 2: DATASET-LEVEL LINEAGE - INDIRECT TRANSFORMATIONS
// =============================================================================

describe("Dataset-Level Lineage: INDIRECT/JOIN", () => {
  test("simple INNER JOIN", () => {
    const sql = `
      SELECT u.id, o.total
      FROM users u
      JOIN orders o ON u.id = o.user_id
    `;
    const ast = parseSQL(sql);
    const schema = createNamespace("ns", [
      createTable(`${DEFAULT_SCHEMA}.users`, ["id"]),
      createTable(`${DEFAULT_SCHEMA}.orders`, ["user_id", "total"]),
    ]);
    const result = getExtendedLineage(ast as Select, schema);

    expect(sortDataset(result.dataset)).toEqual(
      sortDataset([
        { namespace: "ns", name: `${DEFAULT_SCHEMA}.users`, field: "id", transformations: [INDIRECT_JOIN] },
        { namespace: "ns", name: `${DEFAULT_SCHEMA}.orders`, field: "user_id", transformations: [INDIRECT_JOIN] },
      ]),
    );
  });

  test("LEFT JOIN", () => {
    const sql = `
      SELECT u.id, o.total
      FROM users u
      LEFT JOIN orders o ON u.id = o.user_id
    `;
    const ast = parseSQL(sql);
    const schema = createNamespace("ns", [
      createTable(`${DEFAULT_SCHEMA}.users`, ["id"]),
      createTable(`${DEFAULT_SCHEMA}.orders`, ["user_id", "total"]),
    ]);
    const result = getExtendedLineage(ast as Select, schema);

    expect(sortDataset(result.dataset)).toEqual(
      sortDataset([
        { namespace: "ns", name: `${DEFAULT_SCHEMA}.users`, field: "id", transformations: [INDIRECT_JOIN] },
        { namespace: "ns", name: `${DEFAULT_SCHEMA}.orders`, field: "user_id", transformations: [INDIRECT_JOIN] },
      ]),
    );
  });

  test("RIGHT JOIN", () => {
    const sql = `
      SELECT u.id, o.total
      FROM users u
      RIGHT JOIN orders o ON u.id = o.user_id
    `;
    const ast = parseSQL(sql);
    const schema = createNamespace("ns", [
      createTable(`${DEFAULT_SCHEMA}.users`, ["id"]),
      createTable(`${DEFAULT_SCHEMA}.orders`, ["user_id", "total"]),
    ]);
    const result = getExtendedLineage(ast as Select, schema);

    expect(sortDataset(result.dataset)).toEqual(
      sortDataset([
        { namespace: "ns", name: `${DEFAULT_SCHEMA}.users`, field: "id", transformations: [INDIRECT_JOIN] },
        { namespace: "ns", name: `${DEFAULT_SCHEMA}.orders`, field: "user_id", transformations: [INDIRECT_JOIN] },
      ]),
    );
  });

  test("FULL OUTER JOIN", () => {
    const sql = `
      SELECT u.id, o.total
      FROM users u
      FULL OUTER JOIN orders o ON u.id = o.user_id
    `;
    const ast = parseSQL(sql);
    const schema = createNamespace("ns", [
      createTable(`${DEFAULT_SCHEMA}.users`, ["id"]),
      createTable(`${DEFAULT_SCHEMA}.orders`, ["user_id", "total"]),
    ]);
    const result = getExtendedLineage(ast as Select, schema);

    expect(sortDataset(result.dataset)).toEqual(
      sortDataset([
        { namespace: "ns", name: `${DEFAULT_SCHEMA}.users`, field: "id", transformations: [INDIRECT_JOIN] },
        { namespace: "ns", name: `${DEFAULT_SCHEMA}.orders`, field: "user_id", transformations: [INDIRECT_JOIN] },
      ]),
    );
  });

  test("JOIN with compound ON condition (AND)", () => {
    const sql = `
      SELECT u.id
      FROM users u
      JOIN orders o ON u.id = o.user_id AND u.region = o.region
    `;
    const ast = parseSQL(sql);
    const schema = createNamespace("ns", [
      createTable(`${DEFAULT_SCHEMA}.users`, ["id", "region"]),
      createTable(`${DEFAULT_SCHEMA}.orders`, ["user_id", "region"]),
    ]);
    const result = getExtendedLineage(ast as Select, schema);

    expect(sortDataset(result.dataset)).toEqual(
      sortDataset([
        { namespace: "ns", name: `${DEFAULT_SCHEMA}.users`, field: "id", transformations: [INDIRECT_JOIN] },
        { namespace: "ns", name: `${DEFAULT_SCHEMA}.orders`, field: "user_id", transformations: [INDIRECT_JOIN] },
        { namespace: "ns", name: `${DEFAULT_SCHEMA}.users`, field: "region", transformations: [INDIRECT_JOIN] },
        { namespace: "ns", name: `${DEFAULT_SCHEMA}.orders`, field: "region", transformations: [INDIRECT_JOIN] },
      ]),
    );
  });

  test("multiple JOINs - three tables", () => {
    const sql = `
      SELECT u.id, o.total, p.name
      FROM users u
      JOIN orders o ON u.id = o.user_id
      JOIN products p ON o.product_id = p.id
    `;
    const ast = parseSQL(sql);
    const schema = createNamespace("ns", [
      createTable(`${DEFAULT_SCHEMA}.users`, ["id"]),
      createTable(`${DEFAULT_SCHEMA}.orders`, ["user_id", "product_id", "total"]),
      createTable(`${DEFAULT_SCHEMA}.products`, ["id", "name"]),
    ]);
    const result = getExtendedLineage(ast as Select, schema);

    expect(sortDataset(result.dataset)).toEqual(
      sortDataset([
        { namespace: "ns", name: `${DEFAULT_SCHEMA}.users`, field: "id", transformations: [INDIRECT_JOIN] },
        { namespace: "ns", name: `${DEFAULT_SCHEMA}.orders`, field: "user_id", transformations: [INDIRECT_JOIN] },
        { namespace: "ns", name: `${DEFAULT_SCHEMA}.orders`, field: "product_id", transformations: [INDIRECT_JOIN] },
        { namespace: "ns", name: `${DEFAULT_SCHEMA}.products`, field: "id", transformations: [INDIRECT_JOIN] },
      ]),
    );
  });

  test("CROSS JOIN - no dataset lineage", () => {
    const sql = `
      SELECT u.id, p.name
      FROM users u
      CROSS JOIN products p
    `;
    const ast = parseSQL(sql);
    const schema = createNamespace("ns", [
      createTable(`${DEFAULT_SCHEMA}.users`, ["id"]),
      createTable(`${DEFAULT_SCHEMA}.products`, ["name"]),
    ]);
    const result = getExtendedLineage(ast as Select, schema);

    expect(result.dataset).toEqual([]);
  });

  test("self JOIN", () => {
    const sql = `
      SELECT e.name, m.name as manager_name
      FROM employees e
      JOIN employees m ON e.manager_id = m.id
    `;
    const ast = parseSQL(sql);
    const schema = createNamespace("ns", [createTable(`${DEFAULT_SCHEMA}.employees`, ["id", "name", "manager_id"])]);
    const result = getExtendedLineage(ast as Select, schema);

    expect(sortDataset(result.dataset)).toEqual(
      sortDataset([
        { namespace: "ns", name: `${DEFAULT_SCHEMA}.employees`, field: "manager_id", transformations: [INDIRECT_JOIN] },
        { namespace: "ns", name: `${DEFAULT_SCHEMA}.employees`, field: "id", transformations: [INDIRECT_JOIN] },
      ]),
    );
  });
});

describe("Dataset-Level Lineage: INDIRECT/FILTER (WHERE)", () => {
  test("simple WHERE equality", () => {
    const sql = `SELECT id FROM users WHERE status = 'active'`;
    const ast = parseSQL(sql);
    const schema = createNamespace("ns", [createTable(`${DEFAULT_SCHEMA}.users`, ["id", "status"])]);
    const result = getExtendedLineage(ast as Select, schema);

    expect(result.dataset).toEqual([
      { namespace: "ns", name: `${DEFAULT_SCHEMA}.users`, field: "status", transformations: [INDIRECT_FILTER] },
    ]);
  });

  test("WHERE with AND", () => {
    const sql = `SELECT id FROM users WHERE status = 'active' AND age > 18`;
    const ast = parseSQL(sql);
    const schema = createNamespace("ns", [createTable(`${DEFAULT_SCHEMA}.users`, ["id", "status", "age"])]);
    const result = getExtendedLineage(ast as Select, schema);

    expect(sortDataset(result.dataset)).toEqual(
      sortDataset([
        { namespace: "ns", name: `${DEFAULT_SCHEMA}.users`, field: "status", transformations: [INDIRECT_FILTER] },
        { namespace: "ns", name: `${DEFAULT_SCHEMA}.users`, field: "age", transformations: [INDIRECT_FILTER] },
      ]),
    );
  });

  test("WHERE with OR", () => {
    const sql = `SELECT id FROM users WHERE status = 'active' OR status = 'pending'`;
    const ast = parseSQL(sql);
    const schema = createNamespace("ns", [createTable(`${DEFAULT_SCHEMA}.users`, ["id", "status"])]);
    const result = getExtendedLineage(ast as Select, schema);

    // Same column referenced twice, should be deduplicated
    expect(result.dataset).toEqual([
      { namespace: "ns", name: `${DEFAULT_SCHEMA}.users`, field: "status", transformations: [INDIRECT_FILTER] },
    ]);
  });

  test("WHERE with IN clause", () => {
    const sql = `SELECT id FROM users WHERE country IN ('US', 'UK', 'CA')`;
    const ast = parseSQL(sql);
    const schema = createNamespace("ns", [createTable(`${DEFAULT_SCHEMA}.users`, ["id", "country"])]);
    const result = getExtendedLineage(ast as Select, schema);

    expect(result.dataset).toEqual([
      { namespace: "ns", name: `${DEFAULT_SCHEMA}.users`, field: "country", transformations: [INDIRECT_FILTER] },
    ]);
  });

  test("WHERE with IN subquery", () => {
    const sql = `
      SELECT id, name
      FROM users
      WHERE id IN (SELECT user_id FROM orders WHERE total > 100)
    `;
    const ast = parseSQL(sql);
    const schema = createNamespace("ns", [
      createTable(`${DEFAULT_SCHEMA}.users`, ["id", "name"]),
      createTable(`${DEFAULT_SCHEMA}.orders`, ["user_id", "total"]),
    ]);
    const result = getExtendedLineage(ast as Select, schema);

    expect(sortDataset(result.dataset)).toEqual(
      sortDataset([
        { namespace: "ns", name: `${DEFAULT_SCHEMA}.users`, field: "id", transformations: [INDIRECT_FILTER] },
        { namespace: "ns", name: `${DEFAULT_SCHEMA}.orders`, field: "user_id", transformations: [INDIRECT_FILTER] },
        { namespace: "ns", name: `${DEFAULT_SCHEMA}.orders`, field: "total", transformations: [INDIRECT_FILTER] },
      ]),
    );
  });

  test("WHERE with BETWEEN", () => {
    const sql = `SELECT id FROM users WHERE age BETWEEN 18 AND 65`;
    const ast = parseSQL(sql);
    const schema = createNamespace("ns", [createTable(`${DEFAULT_SCHEMA}.users`, ["id", "age"])]);
    const result = getExtendedLineage(ast as Select, schema);

    expect(result.dataset).toEqual([
      { namespace: "ns", name: `${DEFAULT_SCHEMA}.users`, field: "age", transformations: [INDIRECT_FILTER] },
    ]);
  });

  test("WHERE with LIKE", () => {
    const sql = `SELECT id FROM users WHERE name LIKE 'John%'`;
    const ast = parseSQL(sql);
    const schema = createNamespace("ns", [createTable(`${DEFAULT_SCHEMA}.users`, ["id", "name"])]);
    const result = getExtendedLineage(ast as Select, schema);

    expect(result.dataset).toEqual([
      { namespace: "ns", name: `${DEFAULT_SCHEMA}.users`, field: "name", transformations: [INDIRECT_FILTER] },
    ]);
  });

  test("WHERE with IS NULL", () => {
    const sql = `SELECT id FROM users WHERE email IS NULL`;
    const ast = parseSQL(sql);
    const schema = createNamespace("ns", [createTable(`${DEFAULT_SCHEMA}.users`, ["id", "email"])]);
    const result = getExtendedLineage(ast as Select, schema);

    expect(result.dataset).toEqual([
      { namespace: "ns", name: `${DEFAULT_SCHEMA}.users`, field: "email", transformations: [INDIRECT_FILTER] },
    ]);
  });

  test("WHERE with IS NOT NULL", () => {
    const sql = `SELECT id FROM users WHERE email IS NOT NULL`;
    const ast = parseSQL(sql);
    const schema = createNamespace("ns", [createTable(`${DEFAULT_SCHEMA}.users`, ["id", "email"])]);
    const result = getExtendedLineage(ast as Select, schema);

    expect(result.dataset).toEqual([
      { namespace: "ns", name: `${DEFAULT_SCHEMA}.users`, field: "email", transformations: [INDIRECT_FILTER] },
    ]);
  });

  test("WHERE with nested complex conditions", () => {
    const sql = `SELECT id FROM users WHERE (status = 'active' AND age > 18) OR (country = 'US' AND verified = true)`;
    const ast = parseSQL(sql);
    const schema = createNamespace("ns", [
      createTable(`${DEFAULT_SCHEMA}.users`, ["id", "status", "age", "country", "verified"]),
    ]);
    const result = getExtendedLineage(ast as Select, schema);

    expect(sortDataset(result.dataset)).toEqual(
      sortDataset([
        { namespace: "ns", name: `${DEFAULT_SCHEMA}.users`, field: "status", transformations: [INDIRECT_FILTER] },
        { namespace: "ns", name: `${DEFAULT_SCHEMA}.users`, field: "age", transformations: [INDIRECT_FILTER] },
        { namespace: "ns", name: `${DEFAULT_SCHEMA}.users`, field: "country", transformations: [INDIRECT_FILTER] },
        { namespace: "ns", name: `${DEFAULT_SCHEMA}.users`, field: "verified", transformations: [INDIRECT_FILTER] },
      ]),
    );
  });
});

describe("Dataset-Level Lineage: INDIRECT/GROUP_BY", () => {
  test("simple GROUP BY single column", () => {
    const sql = `SELECT country, COUNT(*) FROM users GROUP BY country`;
    const ast = parseSQL(sql);
    const schema = createNamespace("ns", [createTable(`${DEFAULT_SCHEMA}.users`, ["country"])]);
    const result = getExtendedLineage(ast as Select, schema);

    expect(result.dataset).toEqual([
      { namespace: "ns", name: `${DEFAULT_SCHEMA}.users`, field: "country", transformations: [INDIRECT_GROUP_BY] },
    ]);
  });

  test("GROUP BY multiple columns", () => {
    const sql = `SELECT country, city, COUNT(*) FROM users GROUP BY country, city`;
    const ast = parseSQL(sql);
    const schema = createNamespace("ns", [createTable(`${DEFAULT_SCHEMA}.users`, ["country", "city"])]);
    const result = getExtendedLineage(ast as Select, schema);

    expect(sortDataset(result.dataset)).toEqual(
      sortDataset([
        { namespace: "ns", name: `${DEFAULT_SCHEMA}.users`, field: "country", transformations: [INDIRECT_GROUP_BY] },
        { namespace: "ns", name: `${DEFAULT_SCHEMA}.users`, field: "city", transformations: [INDIRECT_GROUP_BY] },
      ]),
    );
  });

  test("GROUP BY with expression", () => {
    const sql = `SELECT DATE_TRUNC('month', created_at) as month, COUNT(*) FROM events GROUP BY DATE_TRUNC('month', created_at)`;
    const ast = parseSQL(sql);
    const schema = createNamespace("ns", [createTable(`${DEFAULT_SCHEMA}.events`, ["id", "created_at"])]);
    const result = getExtendedLineage(ast as Select, schema);

    expect(result.dataset).toEqual([
      { namespace: "ns", name: `${DEFAULT_SCHEMA}.events`, field: "created_at", transformations: [INDIRECT_GROUP_BY] },
    ]);
  });
});

describe("Dataset-Level Lineage: INDIRECT/SORT (ORDER BY)", () => {
  test("simple ORDER BY single column", () => {
    const sql = `SELECT id, name FROM users ORDER BY created_at`;
    const ast = parseSQL(sql);
    const schema = createNamespace("ns", [createTable(`${DEFAULT_SCHEMA}.users`, ["id", "name", "created_at"])]);
    const result = getExtendedLineage(ast as Select, schema);

    expect(result.dataset).toEqual([
      { namespace: "ns", name: `${DEFAULT_SCHEMA}.users`, field: "created_at", transformations: [INDIRECT_SORT] },
    ]);
  });

  test("ORDER BY multiple columns", () => {
    const sql = `SELECT id, name FROM users ORDER BY country ASC, name DESC`;
    const ast = parseSQL(sql);
    const schema = createNamespace("ns", [createTable(`${DEFAULT_SCHEMA}.users`, ["id", "name", "country"])]);
    const result = getExtendedLineage(ast as Select, schema);

    expect(sortDataset(result.dataset)).toEqual(
      sortDataset([
        { namespace: "ns", name: `${DEFAULT_SCHEMA}.users`, field: "country", transformations: [INDIRECT_SORT] },
        { namespace: "ns", name: `${DEFAULT_SCHEMA}.users`, field: "name", transformations: [INDIRECT_SORT] },
      ]),
    );
  });

  test("ORDER BY alias resolves to base columns", () => {
    const sql = `SELECT quantity * price as total FROM order_items ORDER BY total`;
    const ast = parseSQL(sql);
    const schema = createNamespace("ns", [createTable(`${DEFAULT_SCHEMA}.order_items`, ["quantity", "price"])]);
    const result = getExtendedLineage(ast as Select, schema);

    expect(sortDataset(result.dataset)).toEqual(
      sortDataset([
        { namespace: "ns", name: `${DEFAULT_SCHEMA}.order_items`, field: "price", transformations: [INDIRECT_SORT] },
        { namespace: "ns", name: `${DEFAULT_SCHEMA}.order_items`, field: "quantity", transformations: [INDIRECT_SORT] },
      ]),
    );
  });

  test("ORDER BY with NULLS LAST", () => {
    const sql = `SELECT id, name FROM users ORDER BY email NULLS LAST`;
    const ast = parseSQL(sql);
    const schema = createNamespace("ns", [createTable(`${DEFAULT_SCHEMA}.users`, ["id", "name", "email"])]);
    const result = getExtendedLineage(ast as Select, schema);

    expect(result.dataset).toEqual([
      { namespace: "ns", name: `${DEFAULT_SCHEMA}.users`, field: "email", transformations: [INDIRECT_SORT] },
    ]);
  });
});

describe("Dataset-Level Lineage: INDIRECT/FILTER (HAVING)", () => {
  test("HAVING with aggregation column reference", () => {
    const sql = `
      SELECT department, SUM(salary) as total
      FROM employees
      GROUP BY department
      HAVING SUM(salary) > 100000
    `;
    const ast = parseSQL(sql);
    const schema = createNamespace("ns", [createTable(`${DEFAULT_SCHEMA}.employees`, ["department", "salary"])]);
    const result = getExtendedLineage(ast as Select, schema);

    expect(sortDataset(result.dataset)).toEqual(
      sortDataset([
        {
          namespace: "ns",
          name: `${DEFAULT_SCHEMA}.employees`,
          field: "department",
          transformations: [INDIRECT_GROUP_BY],
        },
        { namespace: "ns", name: `${DEFAULT_SCHEMA}.employees`, field: "salary", transformations: [INDIRECT_FILTER] },
      ]),
    );
  });

  test("HAVING with multiple conditions", () => {
    const sql = `
      SELECT department, AVG(age), COUNT(id)
      FROM employees
      GROUP BY department
      HAVING AVG(age) > 30 AND COUNT(id) > 5
    `;
    const ast = parseSQL(sql);
    const schema = createNamespace("ns", [createTable(`${DEFAULT_SCHEMA}.employees`, ["id", "department", "age"])]);
    const result = getExtendedLineage(ast as Select, schema);

    const filterLineage = result.dataset?.filter((d) => d.transformations?.[0]?.subtype === "FILTER");
    expect(filterLineage).toContainEqual({
      namespace: "ns",
      name: `${DEFAULT_SCHEMA}.employees`,
      field: "age",
      transformations: [INDIRECT_FILTER],
    });
    expect(filterLineage).toContainEqual({
      namespace: "ns",
      name: `${DEFAULT_SCHEMA}.employees`,
      field: "id",
      transformations: [INDIRECT_FILTER],
    });
  });
});

// =============================================================================
// SECTION 3: COMBINED CLAUSES
// =============================================================================

describe("Combined Clauses: JOIN + WHERE", () => {
  test("JOIN with WHERE on both tables", () => {
    const sql = `
      SELECT u.id, o.total
      FROM users u
      JOIN orders o ON u.id = o.user_id
      WHERE u.status = 'active' AND o.total > 100
    `;
    const ast = parseSQL(sql);
    const schema = createNamespace("ns", [
      createTable(`${DEFAULT_SCHEMA}.users`, ["id", "status"]),
      createTable(`${DEFAULT_SCHEMA}.orders`, ["user_id", "total"]),
    ]);
    const result = getExtendedLineage(ast as Select, schema);

    expect(sortDataset(result.dataset)).toEqual(
      sortDataset([
        { namespace: "ns", name: `${DEFAULT_SCHEMA}.users`, field: "id", transformations: [INDIRECT_JOIN] },
        { namespace: "ns", name: `${DEFAULT_SCHEMA}.orders`, field: "user_id", transformations: [INDIRECT_JOIN] },
        { namespace: "ns", name: `${DEFAULT_SCHEMA}.users`, field: "status", transformations: [INDIRECT_FILTER] },
        { namespace: "ns", name: `${DEFAULT_SCHEMA}.orders`, field: "total", transformations: [INDIRECT_FILTER] },
      ]),
    );
  });
});

describe("Combined Clauses: WHERE + GROUP BY + HAVING", () => {
  test("full aggregation query", () => {
    const sql = `
      SELECT department, COUNT(*) as cnt, AVG(salary) as avg_sal
      FROM employees
      WHERE status = 'active'
      GROUP BY department
      HAVING COUNT(*) > 5
    `;
    const ast = parseSQL(sql);
    const schema = createNamespace("ns", [
      createTable(`${DEFAULT_SCHEMA}.employees`, ["id", "department", "salary", "status"]),
    ]);
    const result = getExtendedLineage(ast as Select, schema);

    expect(sortDataset(result.dataset)).toEqual(
      sortDataset([
        { namespace: "ns", name: `${DEFAULT_SCHEMA}.employees`, field: "status", transformations: [INDIRECT_FILTER] },
        {
          namespace: "ns",
          name: `${DEFAULT_SCHEMA}.employees`,
          field: "department",
          transformations: [INDIRECT_GROUP_BY],
        },
        // HAVING COUNT(*) doesn't add field lineage since COUNT(*) doesn't reference a column
      ]),
    );
  });
});

describe("Combined Clauses: GROUP BY + ORDER BY", () => {
  test("aggregation with sorting", () => {
    const sql = `
      SELECT country, COUNT(*) as cnt
      FROM users
      GROUP BY country
      ORDER BY cnt DESC
    `;
    const ast = parseSQL(sql);
    const schema = createNamespace("ns", [createTable(`${DEFAULT_SCHEMA}.users`, ["country"])]);
    const result = getExtendedLineage(ast as Select, schema);

    // ORDER BY cnt references alias, which resolves to COUNT(*) - no additional lineage
    expect(result.dataset).toEqual([
      { namespace: "ns", name: `${DEFAULT_SCHEMA}.users`, field: "country", transformations: [INDIRECT_GROUP_BY] },
    ]);
  });
});

describe("Combined Clauses: WINDOW + WHERE + ORDER BY", () => {
  test("window function with filter and sort", () => {
    const sql = `
      SELECT 
        id,
        SUM(amount) OVER (PARTITION BY category ORDER BY created_at) as running_total
      FROM transactions
      WHERE status = 'completed'
      ORDER BY created_at
    `;
    const ast = parseSQL(sql);
    const schema = createNamespace("ns", [
      createTable(`${DEFAULT_SCHEMA}.transactions`, ["id", "amount", "category", "created_at", "status"]),
    ]);
    const result = getExtendedLineage(ast as Select, schema);

    expect(sortDataset(result.dataset)).toEqual(
      sortDataset([
        {
          namespace: "ns",
          name: `${DEFAULT_SCHEMA}.transactions`,
          field: "status",
          transformations: [INDIRECT_FILTER],
        },
        {
          namespace: "ns",
          name: `${DEFAULT_SCHEMA}.transactions`,
          field: "created_at",
          transformations: [INDIRECT_SORT],
        },
      ]),
    );
  });
});

// =============================================================================
// SECTION 4: CTEs (WITH clause)
// =============================================================================

describe("CTEs: Basic WITH clause", () => {
  test("simple CTE propagates field lineage", () => {
    const sql = `
      WITH active AS (
        SELECT id, name FROM users WHERE status = 'active'
      )
      SELECT id, name FROM active
    `;
    const ast = parseSQL(sql);
    const schema = createNamespace("ns", [createTable(`${DEFAULT_SCHEMA}.users`, ["id", "name", "status"])]);
    const result = getExtendedLineage(ast as Select, schema);

    expect(result.fields).toEqual({
      id: {
        inputFields: [
          { namespace: "ns", name: `${DEFAULT_SCHEMA}.users`, field: "id", transformations: [DIRECT_IDENTITY] },
        ],
      },
      name: {
        inputFields: [
          { namespace: "ns", name: `${DEFAULT_SCHEMA}.users`, field: "name", transformations: [DIRECT_IDENTITY] },
        ],
      },
    });

    // Dataset lineage should include the WHERE from the CTE
    expect(result.dataset).toEqual([
      { namespace: "ns", name: `${DEFAULT_SCHEMA}.users`, field: "status", transformations: [INDIRECT_FILTER] },
    ]);
  });

  test("CTE with aggregation", () => {
    const sql = `
      WITH summary AS (
        SELECT department, SUM(salary) as total_salary
        FROM employees
        GROUP BY department
      )
      SELECT department, total_salary FROM summary
    `;
    const ast = parseSQL(sql);
    const schema = createNamespace("ns", [createTable(`${DEFAULT_SCHEMA}.employees`, ["department", "salary"])]);
    const result = getExtendedLineage(ast as Select, schema);

    expect(result.fields).toEqual({
      department: {
        inputFields: [
          {
            namespace: "ns",
            name: `${DEFAULT_SCHEMA}.employees`,
            field: "department",
            transformations: [DIRECT_IDENTITY],
          },
        ],
      },
      total_salary: {
        inputFields: [
          {
            namespace: "ns",
            name: `${DEFAULT_SCHEMA}.employees`,
            field: "salary",
            transformations: [DIRECT_AGGREGATION],
          },
        ],
      },
    });

    // GROUP BY from CTE should be in dataset lineage
    expect(result.dataset).toEqual([
      {
        namespace: "ns",
        name: `${DEFAULT_SCHEMA}.employees`,
        field: "department",
        transformations: [INDIRECT_GROUP_BY],
      },
    ]);
  });
});

describe("CTEs: Multiple CTEs", () => {
  test("two CTEs with JOIN", () => {
    const sql = `
      WITH 
      users_cte AS (
        SELECT id, name FROM users WHERE status = 'active'
      ),
      orders_cte AS (
        SELECT user_id, SUM(total) as total_spent FROM orders GROUP BY user_id
      )
      SELECT u.name, o.total_spent
      FROM users_cte u
      JOIN orders_cte o ON u.id = o.user_id
    `;
    const ast = parseSQL(sql);
    const schema = createNamespace("ns", [
      createTable(`${DEFAULT_SCHEMA}.users`, ["id", "name", "status"]),
      createTable(`${DEFAULT_SCHEMA}.orders`, ["user_id", "total"]),
    ]);
    const result = getExtendedLineage(ast as Select, schema);

    expect(result.fields).toEqual({
      name: {
        inputFields: [
          { namespace: "ns", name: `${DEFAULT_SCHEMA}.users`, field: "name", transformations: [DIRECT_IDENTITY] },
        ],
      },
      total_spent: {
        inputFields: [
          { namespace: "ns", name: `${DEFAULT_SCHEMA}.orders`, field: "total", transformations: [DIRECT_AGGREGATION] },
        ],
      },
    });

    expect(sortDataset(result.dataset)).toEqual(
      sortDataset([
        { namespace: "ns", name: `${DEFAULT_SCHEMA}.users`, field: "status", transformations: [INDIRECT_FILTER] },
        { namespace: "ns", name: `${DEFAULT_SCHEMA}.orders`, field: "user_id", transformations: [INDIRECT_GROUP_BY] },
      ]),
    );
  });
});

describe("CTEs: Nested transformations through CTEs", () => {
  test("transformation propagation through nested CTEs", () => {
    const sql = `
      WITH 
      base AS (
        SELECT id, quantity * price as revenue FROM sales WHERE sale_date >= '2024-01-01'
      ),
      summary AS (
        SELECT SUM(revenue) as total_revenue FROM base
      )
      SELECT total_revenue FROM summary
    `;
    const ast = parseSQL(sql);
    const schema = createNamespace("ns", [
      createTable(`${DEFAULT_SCHEMA}.sales`, ["id", "quantity", "price", "sale_date"]),
    ]);
    const result = getExtendedLineage(ast as Select, schema);

    // total_revenue -> SUM(revenue) -> quantity * price
    expect(sortInputFields(result.fields)).toEqual(
      sortInputFields({
        total_revenue: {
          inputFields: [
            { namespace: "ns", name: `${DEFAULT_SCHEMA}.sales`, field: "price", transformations: [DIRECT_AGGREGATION] },
            {
              namespace: "ns",
              name: `${DEFAULT_SCHEMA}.sales`,
              field: "quantity",
              transformations: [DIRECT_AGGREGATION],
            },
          ],
        },
      }),
    );

    // Dataset lineage includes WHERE from base CTE
    expect(result.dataset).toEqual([
      { namespace: "ns", name: `${DEFAULT_SCHEMA}.sales`, field: "sale_date", transformations: [INDIRECT_FILTER] },
    ]);
  });
});

// =============================================================================
// SECTION 5: SUBQUERIES
// =============================================================================

describe("Subqueries: FROM clause subquery", () => {
  test("simple subquery in FROM", () => {
    const sql = `
      SELECT sub.country, sub.cnt
      FROM (
        SELECT country, COUNT(*) as cnt
        FROM users
        WHERE status = 'active'
        GROUP BY country
      ) sub
    `;
    const ast = parseSQL(sql);
    const schema = createNamespace("ns", [createTable(`${DEFAULT_SCHEMA}.users`, ["country", "status"])]);
    const result = getExtendedLineage(ast as Select, schema);

    expect(result.fields.country?.inputFields).toEqual([
      { namespace: "ns", name: `${DEFAULT_SCHEMA}.users`, field: "country", transformations: [DIRECT_IDENTITY] },
    ]);

    // Dataset lineage from subquery
    expect(sortDataset(result.dataset)).toEqual(
      sortDataset([
        { namespace: "ns", name: `${DEFAULT_SCHEMA}.users`, field: "status", transformations: [INDIRECT_FILTER] },
        { namespace: "ns", name: `${DEFAULT_SCHEMA}.users`, field: "country", transformations: [INDIRECT_GROUP_BY] },
      ]),
    );
  });
});

// =============================================================================
// SECTION 6: SET OPERATIONS (UNION, INTERSECT, EXCEPT)
// =============================================================================

describe("Set Operations: UNION", () => {
  test("simple UNION combines lineage from both queries", () => {
    const sql = `
      SELECT id, name FROM users
      UNION
      SELECT id, name FROM customers
    `;
    const ast = parseSQLPostgres(sql);
    const schema = createNamespace("postgres", [
      createTable("users", ["id", "name", "email"]),
      createTable("customers", ["id", "name", "address"]),
    ]);

    const lineage = getExtendedLineage(ast as Select, schema);

    expect(sortInputFields(lineage.fields)).toEqual(
      sortInputFields({
        id: {
          inputFields: [
            { namespace: "postgres", name: "users", field: "id", transformations: [DIRECT_IDENTITY] },
            { namespace: "postgres", name: "customers", field: "id", transformations: [DIRECT_IDENTITY] },
          ],
        },
        name: {
          inputFields: [
            { namespace: "postgres", name: "users", field: "name", transformations: [DIRECT_IDENTITY] },
            { namespace: "postgres", name: "customers", field: "name", transformations: [DIRECT_IDENTITY] },
          ],
        },
      }),
    );
  });

  test("UNION with WHERE clauses combines field and dataset lineage", () => {
    const sql = `
      SELECT id, name FROM users WHERE status = 'active'
      UNION
      SELECT id, name FROM customers WHERE verified = true
    `;
    const ast = parseSQL(sql, "postgresql");
    const schema = createNamespace("ns", [
      createTable(`${DEFAULT_SCHEMA}.users`, ["id", "name", "status"]),
      createTable(`${DEFAULT_SCHEMA}.customers`, ["id", "name", "verified"]),
    ]);
    const result = getExtendedLineage(ast as Select, schema);

    // Field lineage combines both sources
    expect(sortInputFields(result.fields)).toEqual(
      sortInputFields({
        id: {
          inputFields: [
            { namespace: "ns", name: `${DEFAULT_SCHEMA}.users`, field: "id", transformations: [DIRECT_IDENTITY] },
            { namespace: "ns", name: `${DEFAULT_SCHEMA}.customers`, field: "id", transformations: [DIRECT_IDENTITY] },
          ],
        },
        name: {
          inputFields: [
            { namespace: "ns", name: `${DEFAULT_SCHEMA}.users`, field: "name", transformations: [DIRECT_IDENTITY] },
            { namespace: "ns", name: `${DEFAULT_SCHEMA}.customers`, field: "name", transformations: [DIRECT_IDENTITY] },
          ],
        },
      }),
    );

    // Dataset lineage includes filters from both
    expect(sortDataset(result.dataset)).toEqual(
      sortDataset([
        { namespace: "ns", name: `${DEFAULT_SCHEMA}.users`, field: "status", transformations: [INDIRECT_FILTER] },
        { namespace: "ns", name: `${DEFAULT_SCHEMA}.customers`, field: "verified", transformations: [INDIRECT_FILTER] },
      ]),
    );
  });

  test("UNION ALL combines lineage from both queries", () => {
    const sql = `
      SELECT id FROM users
      UNION ALL
      SELECT id FROM orders
    `;
    const ast = parseSQLPostgres(sql);
    const schema = createNamespace("postgres", [
      createTable("users", ["id", "name"]),
      createTable("orders", ["id", "product"]),
    ]);

    const lineage = getExtendedLineage(ast as Select, schema);

    expect(sortInputFields(lineage.fields)).toEqual(
      sortInputFields({
        id: {
          inputFields: [
            { namespace: "postgres", name: "users", field: "id", transformations: [DIRECT_IDENTITY] },
            { namespace: "postgres", name: "orders", field: "id", transformations: [DIRECT_IDENTITY] },
          ],
        },
      }),
    );
  });

  test("UNION ALL with GROUP BY on both sides", () => {
    const sql = `
      SELECT department FROM employees GROUP BY department
      UNION ALL
      SELECT department FROM contractors GROUP BY department
    `;
    const ast = parseSQL(sql, "postgresql");
    const schema = createNamespace("ns", [
      createTable(`${DEFAULT_SCHEMA}.employees`, ["id", "department"]),
      createTable(`${DEFAULT_SCHEMA}.contractors`, ["id", "department"]),
    ]);
    const result = getExtendedLineage(ast as Select, schema);

    expect(sortDataset(result.dataset)).toEqual(
      sortDataset([
        {
          namespace: "ns",
          name: `${DEFAULT_SCHEMA}.employees`,
          field: "department",
          transformations: [INDIRECT_GROUP_BY],
        },
        {
          namespace: "ns",
          name: `${DEFAULT_SCHEMA}.contractors`,
          field: "department",
          transformations: [INDIRECT_GROUP_BY],
        },
      ]),
    );
  });

  test("chained UNION combines lineage from all queries", () => {
    const sql = `
      SELECT id, name FROM users
      UNION
      SELECT id, name FROM customers
      UNION
      SELECT id, name FROM vendors
    `;
    const ast = parseSQLPostgres(sql);
    const schema = createNamespace("postgres", [
      createTable("users", ["id", "name"]),
      createTable("customers", ["id", "name"]),
      createTable("vendors", ["id", "name"]),
    ]);

    const lineage = getExtendedLineage(ast as Select, schema);

    expect(sortInputFields(lineage.fields)).toEqual(
      sortInputFields({
        id: {
          inputFields: [
            { namespace: "postgres", name: "users", field: "id", transformations: [DIRECT_IDENTITY] },
            { namespace: "postgres", name: "customers", field: "id", transformations: [DIRECT_IDENTITY] },
            { namespace: "postgres", name: "vendors", field: "id", transformations: [DIRECT_IDENTITY] },
          ],
        },
        name: {
          inputFields: [
            { namespace: "postgres", name: "users", field: "name", transformations: [DIRECT_IDENTITY] },
            { namespace: "postgres", name: "customers", field: "name", transformations: [DIRECT_IDENTITY] },
            { namespace: "postgres", name: "vendors", field: "name", transformations: [DIRECT_IDENTITY] },
          ],
        },
      }),
    );
  });

  test("triple UNION with WHERE clauses", () => {
    const sql = `
      SELECT id FROM users WHERE region = 'US'
      UNION
      SELECT id FROM customers WHERE region = 'EU'
      UNION
      SELECT id FROM vendors WHERE region = 'APAC'
    `;
    const ast = parseSQL(sql, "postgresql");
    const schema = createNamespace("ns", [
      createTable(`${DEFAULT_SCHEMA}.users`, ["id", "region"]),
      createTable(`${DEFAULT_SCHEMA}.customers`, ["id", "region"]),
      createTable(`${DEFAULT_SCHEMA}.vendors`, ["id", "region"]),
    ]);
    const result = getExtendedLineage(ast as Select, schema);

    expect(sortDataset(result.dataset)).toEqual(
      sortDataset([
        { namespace: "ns", name: `${DEFAULT_SCHEMA}.users`, field: "region", transformations: [INDIRECT_FILTER] },
        { namespace: "ns", name: `${DEFAULT_SCHEMA}.customers`, field: "region", transformations: [INDIRECT_FILTER] },
        { namespace: "ns", name: `${DEFAULT_SCHEMA}.vendors`, field: "region", transformations: [INDIRECT_FILTER] },
      ]),
    );
  });

  test("UNION with aliases preserves first SELECT column names", () => {
    const sql = `
      SELECT id AS user_id, name AS full_name FROM users
      UNION
      SELECT customer_id, customer_name FROM customers
    `;
    const ast = parseSQLPostgres(sql);
    const schema = createNamespace("postgres", [
      createTable("users", ["id", "name"]),
      createTable("customers", ["customer_id", "customer_name"]),
    ]);

    const lineage = getExtendedLineage(ast as Select, schema);

    // Output columns should be named according to the first SELECT
    expect(sortInputFields(lineage.fields)).toEqual(
      sortInputFields({
        user_id: {
          inputFields: [
            { namespace: "postgres", name: "users", field: "id", transformations: [DIRECT_IDENTITY] },
            { namespace: "postgres", name: "customers", field: "customer_id", transformations: [DIRECT_IDENTITY] },
          ],
        },
        full_name: {
          inputFields: [
            { namespace: "postgres", name: "users", field: "name", transformations: [DIRECT_IDENTITY] },
            { namespace: "postgres", name: "customers", field: "customer_name", transformations: [DIRECT_IDENTITY] },
          ],
        },
      }),
    );
  });

  test("UNION with transformations", () => {
    const sql = `
      SELECT UPPER(name) AS name FROM users
      UNION
      SELECT LOWER(name) AS name FROM customers
    `;
    const ast = parseSQLPostgres(sql);
    const schema = createNamespace("postgres", [
      createTable("users", ["id", "name"]),
      createTable("customers", ["id", "name"]),
    ]);

    const lineage = getExtendedLineage(ast as Select, schema);

    expect(sortInputFields(lineage.fields)).toEqual(
      sortInputFields({
        name: {
          inputFields: [
            { namespace: "postgres", name: "users", field: "name", transformations: [DIRECT_TRANSFORMATION] },
            { namespace: "postgres", name: "customers", field: "name", transformations: [DIRECT_TRANSFORMATION] },
          ],
        },
      }),
    );
  });

  test("UNION with aggregation", () => {
    const sql = `
      SELECT SUM(amount) AS total FROM sales
      UNION
      SELECT SUM(amount) AS total FROM refunds
    `;
    const ast = parseSQLPostgres(sql);
    const schema = createNamespace("postgres", [
      createTable("sales", ["id", "amount"]),
      createTable("refunds", ["id", "amount"]),
    ]);

    const lineage = getExtendedLineage(ast as Select, schema);

    expect(sortInputFields(lineage.fields)).toEqual(
      sortInputFields({
        total: {
          inputFields: [
            { namespace: "postgres", name: "sales", field: "amount", transformations: [DIRECT_AGGREGATION] },
            { namespace: "postgres", name: "refunds", field: "amount", transformations: [DIRECT_AGGREGATION] },
          ],
        },
      }),
    );
  });

  test("UNION with different column expressions", () => {
    const sql = `
      SELECT id, first_name || ' ' || last_name AS full_name FROM users
      UNION
      SELECT id, company_name FROM customers
    `;
    const ast = parseSQLPostgres(sql);
    const schema = createNamespace("postgres", [
      createTable("users", ["id", "first_name", "last_name"]),
      createTable("customers", ["id", "company_name"]),
    ]);

    const lineage = getExtendedLineage(ast as Select, schema);

    expect(sortInputFields(lineage.fields)).toEqual(
      sortInputFields({
        id: {
          inputFields: [
            { namespace: "postgres", name: "users", field: "id", transformations: [DIRECT_IDENTITY] },
            { namespace: "postgres", name: "customers", field: "id", transformations: [DIRECT_IDENTITY] },
          ],
        },
        full_name: {
          inputFields: [
            { namespace: "postgres", name: "users", field: "first_name", transformations: [DIRECT_TRANSFORMATION] },
            { namespace: "postgres", name: "users", field: "last_name", transformations: [DIRECT_TRANSFORMATION] },
            { namespace: "postgres", name: "customers", field: "company_name", transformations: [DIRECT_IDENTITY] },
          ],
        },
      }),
    );
  });

  test("UNION with subqueries", () => {
    const sql = `
      SELECT id FROM (SELECT id FROM users WHERE active = true) AS active_users
      UNION
      SELECT id FROM (SELECT id FROM customers WHERE verified = true) AS verified_customers
    `;
    const ast = parseSQLPostgres(sql);
    const schema = createNamespace("postgres", [
      createTable("users", ["id", "active"]),
      createTable("customers", ["id", "verified"]),
    ]);

    const lineage = getExtendedLineage(ast as Select, schema);

    expect(sortInputFields(lineage.fields)).toEqual(
      sortInputFields({
        id: {
          inputFields: [
            { namespace: "postgres", name: "users", field: "id", transformations: [DIRECT_IDENTITY] },
            { namespace: "postgres", name: "customers", field: "id", transformations: [DIRECT_IDENTITY] },
            // TODO - add support for dataset lineage from subquery WHERE clauses
            // { namespace: "postgres", name: "users", field: "active", transformations: [INDIRECT_FILTER] },
            // { namespace: "postgres", name: "customers", field: "verified", transformations: [INDIRECT_FILTER] },
          ],
        },
      }),
    );
  });

  test("UNION deduplicates identical input fields", () => {
    const sql = `
      SELECT id FROM users
      UNION
      SELECT id FROM users
    `;
    const ast = parseSQLPostgres(sql);
    const schema = createNamespace("postgres", [createTable("users", ["id", "name"])]);

    const lineage = getExtendedLineage(ast as Select, schema);

    // Same table appears in both SELECTs, but should be deduplicated
    expect(lineage.fields).toEqual({
      id: {
        inputFields: [
          {
            name: "users",
            namespace: "postgres",
            field: "id",
            transformations: [DIRECT_IDENTITY],
          },
        ],
      },
    });
  });
});

describe("Set Operations: INTERSECT", () => {
  test("simple INTERSECT combines lineage from both queries", () => {
    const sql = `
      SELECT id FROM users
      INTERSECT
      SELECT id FROM premium_users
    `;
    const ast = parseSQLPostgres(sql);
    const schema = createNamespace("postgres", [
      createTable("users", ["id", "name"]),
      createTable("premium_users", ["id", "tier"]),
    ]);

    const lineage = getExtendedLineage(ast as Select, schema);

    expect(sortInputFields(lineage.fields)).toEqual(
      sortInputFields({
        id: {
          inputFields: [
            { namespace: "postgres", name: "users", field: "id", transformations: [DIRECT_IDENTITY] },
            { namespace: "postgres", name: "premium_users", field: "id", transformations: [DIRECT_IDENTITY] },
          ],
        },
      }),
    );
  });

  test("INTERSECT with ORDER BY on both sides", () => {
    const sql = `
      SELECT id FROM active_users ORDER BY created_at
      INTERSECT
      SELECT id FROM premium_users ORDER BY upgraded_at
    `;
    const ast = parseSQL(sql, "postgresql");
    const schema = createNamespace("ns", [
      createTable(`${DEFAULT_SCHEMA}.active_users`, ["id", "created_at"]),
      createTable(`${DEFAULT_SCHEMA}.premium_users`, ["id", "upgraded_at"]),
    ]);
    const result = getExtendedLineage(ast as Select, schema);

    expect(sortDataset(result.dataset)).toEqual(
      sortDataset([
        {
          namespace: "ns",
          name: `${DEFAULT_SCHEMA}.active_users`,
          field: "created_at",
          transformations: [INDIRECT_SORT],
        },
        {
          namespace: "ns",
          name: `${DEFAULT_SCHEMA}.premium_users`,
          field: "upgraded_at",
          transformations: [INDIRECT_SORT],
        },
      ]),
    );
  });
});

describe("Set Operations: EXCEPT", () => {
  test("simple EXCEPT combines lineage from both queries", () => {
    const sql = `
      SELECT id FROM users
      EXCEPT
      SELECT id FROM banned_users
    `;
    const ast = parseSQLPostgres(sql);
    const schema = createNamespace("postgres", [
      createTable("users", ["id", "name"]),
      createTable("banned_users", ["id", "reason"]),
    ]);

    const lineage = getExtendedLineage(ast as Select, schema);

    expect(sortInputFields(lineage.fields)).toEqual(
      sortInputFields({
        id: {
          inputFields: [
            { namespace: "postgres", name: "users", field: "id", transformations: [DIRECT_IDENTITY] },
            { namespace: "postgres", name: "banned_users", field: "id", transformations: [DIRECT_IDENTITY] },
          ],
        },
      }),
    );
  });

  test("EXCEPT with WHERE on both sides", () => {
    const sql = `
      SELECT id FROM users WHERE active = true
      EXCEPT
      SELECT id FROM banned_users WHERE ban_date > '2024-01-01'
    `;
    const ast = parseSQL(sql, "postgresql");
    const schema = createNamespace("ns", [
      createTable(`${DEFAULT_SCHEMA}.users`, ["id", "active"]),
      createTable(`${DEFAULT_SCHEMA}.banned_users`, ["id", "ban_date"]),
    ]);
    const result = getExtendedLineage(ast as Select, schema);

    expect(sortDataset(result.dataset)).toEqual(
      sortDataset([
        { namespace: "ns", name: `${DEFAULT_SCHEMA}.users`, field: "active", transformations: [INDIRECT_FILTER] },
        {
          namespace: "ns",
          name: `${DEFAULT_SCHEMA}.banned_users`,
          field: "ban_date",
          transformations: [INDIRECT_FILTER],
        },
      ]),
    );
  });
});

// =============================================================================
// SECTION 7: STAR (*) EXPANSION
// =============================================================================

describe("Star Expansion", () => {
  test("SELECT * expands to all columns", () => {
    const sql = `SELECT * FROM users`;
    const ast = parseSQL(sql);
    const usersTable = createTable(`${DEFAULT_SCHEMA}.users`, ["id", "name", "email"]);
    const schema = createNamespace("ns", [usersTable]);
    const result = getExtendedLineage(ast as Select, schema);

    expect(result.fields).toEqual(
      usersTable.columns.reduce(
        (acc, col) => {
          return {
            ...acc,
            [col]: {
              inputFields: [{ namespace: "ns", name: usersTable.name, field: col, transformations: [DIRECT_IDENTITY] }],
            },
          };
        },
        {} as Record<string, any>,
      ),
    );
  });

  test("table.* with multiple tables", () => {
    const sql = `SELECT u.*, o.total FROM users u JOIN orders o ON u.id = o.user_id`;
    const ast = parseSQL(sql);
    const usersTable = createTable(`${DEFAULT_SCHEMA}.users`, ["id", "name", "email"]);
    const schema = createNamespace("ns", [usersTable, createTable(`${DEFAULT_SCHEMA}.orders`, ["user_id", "total"])]);
    const result = getExtendedLineage(ast as Select, schema);

    expect(result.fields).toEqual({
      ...usersTable.columns.reduce(
        (acc, col) => {
          return {
            ...acc,
            [col]: {
              inputFields: [{ namespace: "ns", name: usersTable.name, field: col, transformations: [DIRECT_IDENTITY] }],
            },
          };
        },
        {} as Record<string, any>,
      ),
      total: {
        inputFields: [
          { namespace: "ns", name: `${DEFAULT_SCHEMA}.orders`, field: "total", transformations: [DIRECT_IDENTITY] },
        ],
      },
    });
  });
});

// =============================================================================
// SECTION 8: EDGE CASES
// =============================================================================

describe("Edge Cases", () => {
  test("same column in multiple contexts", () => {
    const sql = `
      SELECT status, COUNT(*) as cnt
      FROM users
      WHERE status != 'deleted'
      GROUP BY status
      ORDER BY status
    `;
    const ast = parseSQL(sql);
    const schema = createNamespace("ns", [createTable(`${DEFAULT_SCHEMA}.users`, ["status"])]);
    const result = getExtendedLineage(ast as Select, schema);

    // Field lineage
    expect(result.fields).toEqual({
      status: {
        inputFields: [
          { namespace: "ns", name: `${DEFAULT_SCHEMA}.users`, field: "status", transformations: [DIRECT_IDENTITY] },
        ],
      },
      cnt: {
        inputFields: [],
      },
    });

    // Dataset lineage should have all three subtypes
    expect(sortDataset(result.dataset)).toEqual(
      sortDataset([
        { namespace: "ns", name: `${DEFAULT_SCHEMA}.users`, field: "status", transformations: [INDIRECT_FILTER] },
        { namespace: "ns", name: `${DEFAULT_SCHEMA}.users`, field: "status", transformations: [INDIRECT_GROUP_BY] },
        { namespace: "ns", name: `${DEFAULT_SCHEMA}.users`, field: "status", transformations: [INDIRECT_SORT] },
      ]),
    );
  });

  test("column name collision from different tables", () => {
    const sql = `
      SELECT u.name as user_name, p.name as product_name
      FROM users u
      JOIN products p ON u.favorite_product = p.id
      WHERE u.name LIKE 'A%' AND p.name LIKE 'Widget%'
    `;
    const ast = parseSQL(sql);
    const schema = createNamespace("ns", [
      createTable(`${DEFAULT_SCHEMA}.users`, ["name", "favorite_product"]),
      createTable(`${DEFAULT_SCHEMA}.products`, ["id", "name"]),
    ]);
    const result = getExtendedLineage(ast as Select, schema);

    expect(result.fields).toEqual({
      user_name: {
        inputFields: [
          { namespace: "ns", name: `${DEFAULT_SCHEMA}.users`, field: "name", transformations: [DIRECT_IDENTITY] },
        ],
      },
      product_name: {
        inputFields: [
          { namespace: "ns", name: `${DEFAULT_SCHEMA}.products`, field: "name", transformations: [DIRECT_IDENTITY] },
        ],
      },
    });

    expect(sortDataset(result.dataset)).toEqual(
      sortDataset([
        { namespace: "ns", name: `${DEFAULT_SCHEMA}.users`, field: "name", transformations: [INDIRECT_FILTER] },
        { namespace: "ns", name: `${DEFAULT_SCHEMA}.products`, field: "name", transformations: [INDIRECT_FILTER] },
        { namespace: "ns", name: `${DEFAULT_SCHEMA}.products`, field: "id", transformations: [INDIRECT_JOIN] },
        {
          namespace: "ns",
          name: `${DEFAULT_SCHEMA}.users`,
          field: "favorite_product",
          transformations: [INDIRECT_JOIN],
        },
      ]),
    );
  });

  test("deduplication of repeated column in same clause", () => {
    const sql = `SELECT id FROM users WHERE status = 'active' AND status != 'banned'`;
    const ast = parseSQL(sql);
    const schema = createNamespace("ns", [createTable(`${DEFAULT_SCHEMA}.users`, ["id", "status"])]);
    const result = getExtendedLineage(ast as Select, schema);

    // status appears twice but should be deduplicated
    expect(result.dataset).toEqual([
      { namespace: "ns", name: `${DEFAULT_SCHEMA}.users`, field: "status", transformations: [INDIRECT_FILTER] },
    ]);
  });

  test("empty dataset lineage when no indirect clauses", () => {
    const sql = `SELECT id, UPPER(name) as upper_name FROM users`;
    const ast = parseSQL(sql);
    const schema = createNamespace("ns", [createTable(`${DEFAULT_SCHEMA}.users`, ["id", "name"])]);
    const result = getExtendedLineage(ast as Select, schema);

    expect(result.dataset).toEqual([]);
  });
});

// =============================================================================
// SECTION 9: COMPREHENSIVE MEGA-QUERIES
// =============================================================================

describe("Comprehensive: Everything Together", () => {
  test("mega query with all features", () => {
    const sql = `
      WITH 
      filtered_sales AS (
        SELECT 
          product_id,
          store_id,
          quantity,
          unit_price,
          quantity * unit_price as line_total
        FROM sales
        WHERE sale_date >= '2024-01-01'
          AND status = 'completed'
      ),
      store_totals AS (
        SELECT 
          store_id,
          SUM(line_total) as total_revenue,
          COUNT(product_id) as product_count,
          AVG(unit_price) as avg_price
        FROM filtered_sales
        GROUP BY store_id
        HAVING SUM(line_total) > 1000
      )
      SELECT 
        s.name as store_name,
        s.region,
        st.total_revenue,
        st.product_count,
        st.avg_price,
        CASE 
          WHEN st.total_revenue > 100000 THEN 'Premium'
          WHEN st.total_revenue > 50000 THEN 'Standard'
          ELSE 'Basic'
        END as tier,
        RANK() OVER (PARTITION BY s.region ORDER BY st.total_revenue DESC) as region_rank,
        MD5(s.name) as store_hash
      FROM store_totals st
      JOIN stores s ON st.store_id = s.id
      WHERE s.active = true
      ORDER BY s.region, st.total_revenue DESC
    `;
    const ast = parseSQL(sql);
    const schema = createNamespace("ns", [
      createTable(`${DEFAULT_SCHEMA}.sales`, [
        "id",
        "product_id",
        "store_id",
        "quantity",
        "unit_price",
        "sale_date",
        "status",
      ]),
      createTable(`${DEFAULT_SCHEMA}.stores`, ["id", "name", "region", "active"]),
    ]);
    const result = getExtendedLineage(ast as Select, schema);

    // ========== FIELD-LEVEL LINEAGE ==========

    expect(result.fields).toEqual({
      store_name: {
        inputFields: [
          { namespace: "ns", name: `${DEFAULT_SCHEMA}.stores`, field: "name", transformations: [DIRECT_IDENTITY] },
        ],
      },
      region: {
        inputFields: [
          { namespace: "ns", name: `${DEFAULT_SCHEMA}.stores`, field: "region", transformations: [DIRECT_IDENTITY] },
        ],
      },
      total_revenue: {
        inputFields: [
          {
            namespace: "ns",
            name: `${DEFAULT_SCHEMA}.sales`,
            field: "quantity",
            transformations: [DIRECT_AGGREGATION],
          },
          {
            namespace: "ns",
            name: `${DEFAULT_SCHEMA}.sales`,
            field: "unit_price",
            transformations: [DIRECT_AGGREGATION],
          },
        ],
      },
      product_count: {
        inputFields: [
          {
            namespace: "ns",
            name: `${DEFAULT_SCHEMA}.sales`,
            field: "product_id",
            transformations: [{ type: "DIRECT", subtype: "AGGREGATION", masking: true }],
          },
        ],
      },
      avg_price: {
        inputFields: [
          {
            namespace: "ns",
            name: `${DEFAULT_SCHEMA}.sales`,
            field: "unit_price",
            transformations: [DIRECT_AGGREGATION],
          },
        ],
      },
      tier: {
        inputFields: [
          {
            namespace: "ns",
            name: `${DEFAULT_SCHEMA}.sales`,
            field: "quantity",
            transformations: [INDIRECT_CONDITION],
          },
          {
            namespace: "ns",
            name: `${DEFAULT_SCHEMA}.sales`,
            field: "unit_price",
            transformations: [INDIRECT_CONDITION],
          },
        ],
      },
      region_rank: {
        inputFields: [
          { namespace: "ns", name: `${DEFAULT_SCHEMA}.stores`, field: "region", transformations: [INDIRECT_WINDOW] },
          {
            namespace: "ns",
            name: `${DEFAULT_SCHEMA}.sales`,
            field: "quantity",
            transformations: [INDIRECT_WINDOW],
          },
          {
            namespace: "ns",
            name: `${DEFAULT_SCHEMA}.sales`,
            field: "unit_price",
            transformations: [INDIRECT_WINDOW],
          },
        ],
      },
      store_hash: {
        inputFields: [
          {
            namespace: "ns",
            name: `${DEFAULT_SCHEMA}.stores`,
            field: "name",
            transformations: [{ type: "DIRECT", subtype: "TRANSFORMATION", masking: true }],
          },
        ],
      },
    });

    // ========== DATASET-LEVEL LINEAGE ==========

    expect(sortDataset(result.dataset)).toEqual(
      sortDataset([
        // FILTER from filtered_sales CTE (WHERE sale_date >= ... AND status = ...)
        { namespace: "ns", name: `${DEFAULT_SCHEMA}.sales`, field: "sale_date", transformations: [INDIRECT_FILTER] },
        { namespace: "ns", name: `${DEFAULT_SCHEMA}.sales`, field: "status", transformations: [INDIRECT_FILTER] },
        // FILTER from main query (WHERE s.active = true)
        { namespace: "ns", name: `${DEFAULT_SCHEMA}.stores`, field: "active", transformations: [INDIRECT_FILTER] },
        // FILTER from store_totals CTE (HAVING SUM(line_total) > 1000)
        // { namespace: "ns", name: `${DEFAULT_SCHEMA}.sales`, field: "quantity", transformations: [INDIRECT_FILTER] },
        // { namespace: "ns", name: `${DEFAULT_SCHEMA}.sales`, field: "unit_price", transformations: [INDIRECT_FILTER] },
        // JOIN from main query (st.store_id = s.id)
        { namespace: "ns", name: `${DEFAULT_SCHEMA}.stores`, field: "id", transformations: [INDIRECT_JOIN] },
        // GROUP BY from store_totals CTE (GROUP BY store_id)
        // { namespace: "ns", name: `${DEFAULT_SCHEMA}.sales`, field: "store_id", transformations: [INDIRECT_GROUP_BY] },
        // SORT from main query (ORDER BY s.region, st.total_revenue DESC)
        { namespace: "ns", name: `${DEFAULT_SCHEMA}.stores`, field: "region", transformations: [INDIRECT_SORT] },
        // { namespace: "ns", name: `${DEFAULT_SCHEMA}.sales`, field: "quantity", transformations: [INDIRECT_SORT] },
        // { namespace: "ns", name: `${DEFAULT_SCHEMA}.sales`, field: "unit_price", transformations: [INDIRECT_SORT] },
      ]),
    );

    // Verify we have all 8 output fields
    expect(Object.keys(result.fields).length).toBe(8);
  });

  test("e-commerce analytics mega query", () => {
    const sql = `
      SELECT 
        c.name as category_name,
        p.name as product_name,
        SUM(oi.quantity) as total_qty,
        SUM(oi.quantity * oi.price) as revenue,
        AVG(oi.price) as avg_price,
        COUNT(DISTINCT o.customer_id) as unique_customers,
        ROW_NUMBER() OVER (PARTITION BY c.id ORDER BY SUM(oi.quantity * oi.price) DESC) as category_rank
      FROM categories c
      JOIN products p ON c.id = p.category_id
      JOIN order_items oi ON p.id = oi.product_id
      JOIN orders o ON oi.order_id = o.id
      WHERE o.status = 'completed' 
        AND o.created_at >= '2024-01-01'
        AND p.active = true
      GROUP BY c.id, c.name, p.id, p.name
      HAVING SUM(oi.quantity) > 10
      ORDER BY c.name, revenue DESC
    `;
    const ast = parseSQL(sql);
    const schema = createNamespace("ns", [
      createTable(`${DEFAULT_SCHEMA}.categories`, ["id", "name"]),
      createTable(`${DEFAULT_SCHEMA}.products`, ["id", "name", "category_id", "active"]),
      createTable(`${DEFAULT_SCHEMA}.order_items`, ["id", "order_id", "product_id", "quantity", "price"]),
      createTable(`${DEFAULT_SCHEMA}.orders`, ["id", "customer_id", "status", "created_at"]),
    ]);
    const result = getExtendedLineage(ast as Select, schema);

    // ========== FIELD-LEVEL LINEAGE ==========

    // Verify we have all 7 output fields
    expect(Object.keys(result.fields).length).toBe(7);

    expect(result.fields.category_name?.inputFields).toEqual([
      { namespace: "ns", name: `${DEFAULT_SCHEMA}.categories`, field: "name", transformations: [DIRECT_IDENTITY] },
    ]);

    expect(result.fields.product_name?.inputFields).toEqual([
      { namespace: "ns", name: `${DEFAULT_SCHEMA}.products`, field: "name", transformations: [DIRECT_IDENTITY] },
    ]);

    expect(result.fields.total_qty?.inputFields).toEqual([
      {
        namespace: "ns",
        name: `${DEFAULT_SCHEMA}.order_items`,
        field: "quantity",
        transformations: [DIRECT_AGGREGATION],
      },
    ]);

    expect(sortInputFields({ revenue: result.fields.revenue! })).toEqual(
      sortInputFields({
        revenue: {
          inputFields: [
            {
              namespace: "ns",
              name: `${DEFAULT_SCHEMA}.order_items`,
              field: "price",
              transformations: [DIRECT_AGGREGATION],
            },
            {
              namespace: "ns",
              name: `${DEFAULT_SCHEMA}.order_items`,
              field: "quantity",
              transformations: [DIRECT_AGGREGATION],
            },
          ],
        },
      }),
    );

    expect(result.fields.avg_price?.inputFields).toEqual([
      { namespace: "ns", name: `${DEFAULT_SCHEMA}.order_items`, field: "price", transformations: [DIRECT_AGGREGATION] },
    ]);

    expect(result.fields.unique_customers?.inputFields).toEqual([
      {
        namespace: "ns",
        name: `${DEFAULT_SCHEMA}.orders`,
        field: "customer_id",
        transformations: [{ type: "DIRECT", subtype: "AGGREGATION", masking: true }],
      },
    ]);

    expect(sortInputFields({ category_rank: result.fields.category_rank! })).toEqual(
      sortInputFields({
        category_rank: {
          inputFields: [
            { namespace: "ns", name: `${DEFAULT_SCHEMA}.categories`, field: "id", transformations: [INDIRECT_WINDOW] },
            {
              namespace: "ns",
              name: `${DEFAULT_SCHEMA}.order_items`,
              field: "price",
              transformations: [INDIRECT_WINDOW],
            },
            {
              namespace: "ns",
              name: `${DEFAULT_SCHEMA}.order_items`,
              field: "quantity",
              transformations: [INDIRECT_WINDOW],
            },
          ],
        },
      }),
    );

    // ========== DATASET-LEVEL LINEAGE ==========

    expect(sortDataset(result.dataset)).toEqual(
      sortDataset([
        // JOIN lineage - 3 joins with 2 columns each = 6 total
        {
          namespace: "ns",
          name: `${DEFAULT_SCHEMA}.categories`,
          field: "id",
          transformations: [INDIRECT_JOIN],
        },
        {
          namespace: "ns",
          name: `${DEFAULT_SCHEMA}.products`,
          field: "category_id",
          transformations: [INDIRECT_JOIN],
        },
        {
          namespace: "ns",
          name: `${DEFAULT_SCHEMA}.products`,
          field: "id",
          transformations: [INDIRECT_JOIN],
        },
        {
          namespace: "ns",
          name: `${DEFAULT_SCHEMA}.order_items`,
          field: "product_id",
          transformations: [INDIRECT_JOIN],
        },
        {
          namespace: "ns",
          name: `${DEFAULT_SCHEMA}.order_items`,
          field: "order_id",
          transformations: [INDIRECT_JOIN],
        },
        {
          namespace: "ns",
          name: `${DEFAULT_SCHEMA}.orders`,
          field: "id",
          transformations: [INDIRECT_JOIN],
        },
        // FILTER lineage - status, created_at, active + HAVING quantity
        {
          namespace: "ns",
          name: `${DEFAULT_SCHEMA}.orders`,
          field: "status",
          transformations: [INDIRECT_FILTER],
        },
        {
          namespace: "ns",
          name: `${DEFAULT_SCHEMA}.orders`,
          field: "created_at",
          transformations: [INDIRECT_FILTER],
        },
        {
          namespace: "ns",
          name: `${DEFAULT_SCHEMA}.products`,
          field: "active",
          transformations: [INDIRECT_FILTER],
        },
        {
          namespace: "ns",
          name: `${DEFAULT_SCHEMA}.order_items`,
          field: "quantity",
          transformations: [INDIRECT_FILTER],
        },
        // GROUP BY lineage - c.id, c.name, p.id, p.name
        {
          namespace: "ns",
          name: `${DEFAULT_SCHEMA}.categories`,
          field: "id",
          transformations: [INDIRECT_GROUP_BY],
        },
        {
          namespace: "ns",
          name: `${DEFAULT_SCHEMA}.categories`,
          field: "name",
          transformations: [INDIRECT_GROUP_BY],
        },
        {
          namespace: "ns",
          name: `${DEFAULT_SCHEMA}.products`,
          field: "id",
          transformations: [INDIRECT_GROUP_BY],
        },
        {
          namespace: "ns",
          name: `${DEFAULT_SCHEMA}.products`,
          field: "name",
          transformations: [INDIRECT_GROUP_BY],
        },
        // SORT lineage - c.name, revenue (quantity * price)
        {
          namespace: "ns",
          name: `${DEFAULT_SCHEMA}.categories`,
          field: "name",
          transformations: [INDIRECT_SORT],
        },
        {
          namespace: "ns",
          name: `${DEFAULT_SCHEMA}.order_items`,
          field: "price",
          transformations: [INDIRECT_SORT],
        },
        {
          namespace: "ns",
          name: `${DEFAULT_SCHEMA}.order_items`,
          field: "quantity",
          transformations: [INDIRECT_SORT],
        },
      ]),
    );
  });

  test("HR analytics mega query with complex CTEs and CASE", () => {
    const sql = `
      WITH 
      active_employees AS (
        SELECT 
          id,
          department_id,
          salary,
          hire_date,
          performance_score
        FROM employees
        WHERE status = 'active' AND terminated_at IS NULL
      ),
      dept_stats AS (
        SELECT 
          department_id,
          COUNT(id) as headcount,
          SUM(salary) as total_compensation,
          AVG(salary) as avg_salary,
          MIN(hire_date) as oldest_hire,
          AVG(performance_score) as avg_performance
        FROM active_employees
        GROUP BY department_id
        HAVING COUNT(id) >= 3
      )
      SELECT 
        d.name as department_name,
        d.location,
        ds.headcount,
        ds.total_compensation,
        ds.avg_salary,
        ds.avg_performance,
        CASE 
          WHEN ds.avg_performance >= 4.5 THEN 'Exceptional'
          WHEN ds.avg_performance >= 3.5 THEN 'Good'
          WHEN ds.avg_performance >= 2.5 THEN 'Average'
          ELSE 'Needs Improvement'
        END as performance_tier,
        DENSE_RANK() OVER (ORDER BY ds.total_compensation DESC) as compensation_rank,
        ROW_NUMBER() OVER (PARTITION BY d.location ORDER BY ds.headcount DESC) as location_rank,
        SHA256(d.name) as dept_hash
      FROM dept_stats ds
      JOIN departments d ON ds.department_id = d.id
      WHERE d.active = true
      ORDER BY d.location, ds.total_compensation DESC
    `;
    const ast = parseSQL(sql);
    const schema = createNamespace("ns", [
      createTable(`${DEFAULT_SCHEMA}.employees`, [
        "id",
        "department_id",
        "salary",
        "hire_date",
        "performance_score",
        "status",
        "terminated_at",
      ]),
      createTable(`${DEFAULT_SCHEMA}.departments`, ["id", "name", "location", "active"]),
    ]);
    const result = getExtendedLineage(ast as Select, schema);

    // ========== FIELD-LEVEL LINEAGE ==========

    expect(result.fields).toEqual({
      department_name: {
        inputFields: [
          { namespace: "ns", name: `${DEFAULT_SCHEMA}.departments`, field: "name", transformations: [DIRECT_IDENTITY] },
        ],
      },
      location: {
        inputFields: [
          {
            namespace: "ns",
            name: `${DEFAULT_SCHEMA}.departments`,
            field: "location",
            transformations: [DIRECT_IDENTITY],
          },
        ],
      },
      headcount: {
        inputFields: [
          {
            namespace: "ns",
            name: `${DEFAULT_SCHEMA}.employees`,
            field: "id",
            transformations: [{ type: "DIRECT", subtype: "AGGREGATION", masking: true }],
          },
        ],
      },
      total_compensation: {
        inputFields: [
          {
            namespace: "ns",
            name: `${DEFAULT_SCHEMA}.employees`,
            field: "salary",
            transformations: [DIRECT_AGGREGATION],
          },
        ],
      },
      avg_salary: {
        inputFields: [
          {
            namespace: "ns",
            name: `${DEFAULT_SCHEMA}.employees`,
            field: "salary",
            transformations: [DIRECT_AGGREGATION],
          },
        ],
      },
      avg_performance: {
        inputFields: [
          {
            namespace: "ns",
            name: `${DEFAULT_SCHEMA}.employees`,
            field: "performance_score",
            transformations: [DIRECT_AGGREGATION],
          },
        ],
      },
      performance_tier: {
        inputFields: [
          {
            namespace: "ns",
            name: `${DEFAULT_SCHEMA}.employees`,
            field: "performance_score",
            transformations: [INDIRECT_CONDITION],
          },
        ],
      },
      compensation_rank: {
        inputFields: [
          {
            namespace: "ns",
            name: `${DEFAULT_SCHEMA}.employees`,
            field: "salary",
            transformations: [INDIRECT_WINDOW],
          },
        ],
      },
      location_rank: {
        inputFields: [
          {
            namespace: "ns",
            name: `${DEFAULT_SCHEMA}.departments`,
            field: "location",
            transformations: [INDIRECT_WINDOW],
          },
          {
            namespace: "ns",
            name: `${DEFAULT_SCHEMA}.employees`,
            field: "id",
            transformations: [{ type: "INDIRECT", subtype: "WINDOW", masking: true }],
          },
        ],
      },
      dept_hash: {
        inputFields: [
          {
            namespace: "ns",
            name: `${DEFAULT_SCHEMA}.departments`,
            field: "name",
            transformations: [{ type: "DIRECT", subtype: "TRANSFORMATION", masking: true }],
          },
        ],
      },
    });

    // ========== DATASET-LEVEL LINEAGE ==========

    // FILTER from active_employees CTE
    expect(sortDataset(result.dataset)).toEqual(
      sortDataset([
        // FILTER from active_employees CTE (WHERE status = 'active' AND terminated_at IS NULL)
        { namespace: "ns", name: `${DEFAULT_SCHEMA}.employees`, field: "status", transformations: [INDIRECT_FILTER] },
        {
          namespace: "ns",
          name: `${DEFAULT_SCHEMA}.employees`,
          field: "terminated_at",
          transformations: [INDIRECT_FILTER],
        },
        // FILTER from main query (WHERE d.active = true)
        { namespace: "ns", name: `${DEFAULT_SCHEMA}.departments`, field: "active", transformations: [INDIRECT_FILTER] },
        // FILTER from dept_stats CTE (HAVING COUNT(id) >= 3) TODO
        // { namespace: "ns", name: `${DEFAULT_SCHEMA}.employees`, field: "id", transformations: [INDIRECT_FILTER] },
        // JOIN from main query (ds.department_id = d.id)
        { namespace: "ns", name: `${DEFAULT_SCHEMA}.departments`, field: "id", transformations: [INDIRECT_JOIN] },
        // GROUP BY from dept_stats CTE (GROUP BY department_id) TODO
        // {
        //   namespace: "ns",
        //   name: `${DEFAULT_SCHEMA}.employees`,
        //   field: "department_id",
        //   transformations: [INDIRECT_GROUP_BY],
        // },
        // SORT from main query (ORDER BY d.location, ds.total_compensation DESC)
        { namespace: "ns", name: `${DEFAULT_SCHEMA}.departments`, field: "location", transformations: [INDIRECT_SORT] },
        // TODO - fix
        // { namespace: "ns", name: `${DEFAULT_SCHEMA}.employees`, field: "salary", transformations: [INDIRECT_SORT] },
      ]),
    );
  });

  test("UNION with CTEs and window functions mega query", () => {
    const sql = `
      WITH 
      us_sales AS (
        SELECT 
          product_id,
          SUM(amount) as total_amount,
          COUNT(*) as sale_count
        FROM sales
        WHERE region = 'US' AND sale_date >= '2024-01-01'
        GROUP BY product_id
      ),
      eu_sales AS (
        SELECT 
          product_id,
          SUM(amount) as total_amount,
          COUNT(*) as sale_count
        FROM sales
        WHERE region = 'EU' AND sale_date >= '2024-01-01'
        GROUP BY product_id
      )
      SELECT 
        'US' as region,
        p.name as product_name,
        us.total_amount,
        us.sale_count,
        RANK() OVER (ORDER BY us.total_amount DESC) as revenue_rank
      FROM us_sales us
      JOIN products p ON us.product_id = p.id
      WHERE p.active = true
      
      UNION ALL
      
      SELECT 
        'EU' as region,
        p.name as product_name,
        eu.total_amount,
        eu.sale_count,
        RANK() OVER (ORDER BY eu.total_amount DESC) as revenue_rank
      FROM eu_sales eu
      JOIN products p ON eu.product_id = p.id
      WHERE p.active = true
    `;
    const ast = parseSQL(sql, "postgresql");
    const schema = createNamespace("ns", [
      createTable(`${DEFAULT_SCHEMA}.sales`, ["id", "product_id", "amount", "region", "sale_date"]),
      createTable(`${DEFAULT_SCHEMA}.products`, ["id", "name", "active"]),
    ]);
    const result = getExtendedLineage(ast as Select, schema);

    // Field lineage - product_name comes from products.name
    // Both UNION parts join the same products table, so we get one unique entry per field
    // (the mergeInputFields deduplicates by full field identity including transformations)
    expect(result.fields).toEqual({
      region: {
        inputFields: [],
      },
      product_name: {
        inputFields: [
          { namespace: "ns", name: `${DEFAULT_SCHEMA}.products`, field: "name", transformations: [DIRECT_IDENTITY] },
        ],
      },
      total_amount: {
        inputFields: [
          { namespace: "ns", name: `${DEFAULT_SCHEMA}.sales`, field: "amount", transformations: [DIRECT_AGGREGATION] },
        ],
      },
      sale_count: {
        inputFields: [],
      },
      revenue_rank: {
        inputFields: [],
      },
    });

    // Dataset lineage from both CTEs and both UNION parts
    expect(sortDataset(result.dataset)).toEqual(
      sortDataset([
        // FILTER from both CTEs: WHERE region = '...' AND sale_date >= '...'
        { namespace: "ns", name: `${DEFAULT_SCHEMA}.sales`, field: "region", transformations: [INDIRECT_FILTER] },
        { namespace: "ns", name: `${DEFAULT_SCHEMA}.sales`, field: "sale_date", transformations: [INDIRECT_FILTER] },
        // FILTER from both outer queries: WHERE p.active = true
        { namespace: "ns", name: `${DEFAULT_SCHEMA}.products`, field: "active", transformations: [INDIRECT_FILTER] },
        // GROUP BY from both CTEs (deduplicated since same table.field)
        { namespace: "ns", name: `${DEFAULT_SCHEMA}.sales`, field: "product_id", transformations: [INDIRECT_GROUP_BY] },
        // JOIN from both UNION parts
        { namespace: "ns", name: `${DEFAULT_SCHEMA}.products`, field: "id", transformations: [INDIRECT_JOIN] },
      ]),
    );
  });
});

// =============================================================================
// SECTION 10: SCHEMA HANDLING (DEFAULT & MULTI-SCHEMA SUPPORT)
// =============================================================================

describe("Default Schema Handling", () => {
  test("matches table with default schema", () => {
    const sql = `SELECT id, name FROM users`;
    const ast = parseSQL(sql);
    const schema = createNamespace("ns", [createTable(`${DEFAULT_SCHEMA}.users`, ["id", "name"])], "public");
    const result = getExtendedLineage(ast as Select, schema);

    expect(result.fields).toEqual({
      id: {
        inputFields: [
          { namespace: "ns", name: `${DEFAULT_SCHEMA}.users`, field: "id", transformations: [DIRECT_IDENTITY] },
        ],
      },
      name: {
        inputFields: [
          { namespace: "ns", name: `${DEFAULT_SCHEMA}.users`, field: "name", transformations: [DIRECT_IDENTITY] },
        ],
      },
    });
  });

  test("schema-qualified table name", () => {
    const sql = `SELECT u.id FROM analytics.users u WHERE u.status = 'active'`;
    const ast = parseSQL(sql);
    const schema = createNamespace("ns", [createTable("analytics.users", ["id", "status"])]);
    const result = getExtendedLineage(ast as Select, schema);

    expect(result.fields).toEqual({
      id: {
        inputFields: [{ namespace: "ns", name: "analytics.users", field: "id", transformations: [DIRECT_IDENTITY] }],
      },
    });

    expect(result.dataset).toEqual([
      { namespace: "ns", name: "analytics.users", field: "status", transformations: [INDIRECT_FILTER] },
    ]);
  });
});

describe("Multi-Schema Support", () => {
  test("select from table with explicit schema", () => {
    const sql = `SELECT id, name FROM myschema.users`;
    const ast = parseSQL(sql);
    const namespace = createNamespace("trino", [
      createTable("myschema.users", ["id", "name", "email"]),
      createTable("otherschema.users", ["id", "username"]),
    ]);

    const lineage = getExtendedLineage(ast as Select, namespace);

    expect(lineage.fields).toEqual({
      id: {
        inputFields: [
          {
            name: "myschema.users",
            namespace: "trino",
            field: "id",
            transformations: [DIRECT_IDENTITY],
          },
        ],
      },
      name: {
        inputFields: [
          {
            name: "myschema.users",
            namespace: "trino",
            field: "name",
            transformations: [DIRECT_IDENTITY],
          },
        ],
      },
    });
  });

  test("select from table with default schema", () => {
    const sql = `SELECT id, name FROM users`;
    const ast = parseSQL(sql);
    const namespace = createNamespace(
      "trino",
      [createTable("myschema.users", ["id", "name", "email"]), createTable("otherschema.users", ["id", "username"])],
      "myschema", // default schema
    );

    const lineage = getExtendedLineage(ast as Select, namespace);

    expect(lineage.fields).toEqual({
      id: {
        inputFields: [
          {
            name: "myschema.users",
            namespace: "trino",
            field: "id",
            transformations: [DIRECT_IDENTITY],
          },
        ],
      },
      name: {
        inputFields: [
          {
            name: "myschema.users",
            namespace: "trino",
            field: "name",
            transformations: [DIRECT_IDENTITY],
          },
        ],
      },
    });
  });

  test("join across different schemas", () => {
    const sql = `
      SELECT 
        u.id,
        u.name,
        o.total
      FROM myschema.users u
      JOIN orders_schema.orders o ON u.id = o.user_id
    `;
    const ast = parseSQL(sql);
    const namespace = createNamespace("trino", [
      createTable("myschema.users", ["id", "name"]),
      createTable("orders_schema.orders", ["id", "user_id", "total"]),
    ]);

    const lineage = getExtendedLineage(ast as Select, namespace);

    expect(lineage.fields).toEqual({
      id: {
        inputFields: [
          {
            name: "myschema.users",
            namespace: "trino",
            field: "id",
            transformations: [DIRECT_IDENTITY],
          },
        ],
      },
      name: {
        inputFields: [
          {
            name: "myschema.users",
            namespace: "trino",
            field: "name",
            transformations: [DIRECT_IDENTITY],
          },
        ],
      },
      total: {
        inputFields: [
          {
            name: "orders_schema.orders",
            namespace: "trino",
            field: "total",
            transformations: [DIRECT_IDENTITY],
          },
        ],
      },
    });
  });

  test("mix explicit and default schema tables", () => {
    const sql = `
      SELECT 
        u.id,
        u.name,
        o.total
      FROM users u
      JOIN orders_schema.orders o ON u.id = o.user_id
    `;
    const ast = parseSQL(sql);
    const namespace = createNamespace(
      "trino",
      [createTable("myschema.users", ["id", "name"]), createTable("orders_schema.orders", ["id", "user_id", "total"])],
      "myschema", // default schema
    );

    const lineage = getExtendedLineage(ast as Select, namespace);

    expect(lineage.fields).toEqual({
      id: {
        inputFields: [
          {
            name: "myschema.users",
            namespace: "trino",
            field: "id",
            transformations: [DIRECT_IDENTITY],
          },
        ],
      },
      name: {
        inputFields: [
          {
            name: "myschema.users",
            namespace: "trino",
            field: "name",
            transformations: [DIRECT_IDENTITY],
          },
        ],
      },
      total: {
        inputFields: [
          {
            name: "orders_schema.orders",
            namespace: "trino",
            field: "total",
            transformations: [DIRECT_IDENTITY],
          },
        ],
      },
    });
  });

  test("same table name in different schemas", () => {
    const sql = `
      SELECT 
        u1.id as user1_id,
        u2.id as user2_id
      FROM schema1.users u1
      JOIN schema2.users u2 ON u1.id = u2.id
    `;
    const ast = parseSQL(sql);
    const namespace = createNamespace("trino", [
      createTable("schema1.users", ["id", "name"]),
      createTable("schema2.users", ["id", "username"]),
    ]);

    const lineage = getExtendedLineage(ast as Select, namespace);

    expect(lineage.fields).toEqual({
      user1_id: {
        inputFields: [
          {
            name: "schema1.users",
            namespace: "trino",
            field: "id",
            transformations: [DIRECT_IDENTITY],
          },
        ],
      },
      user2_id: {
        inputFields: [
          {
            name: "schema2.users",
            namespace: "trino",
            field: "id",
            transformations: [DIRECT_IDENTITY],
          },
        ],
      },
    });
  });

  test("CTE with schema-qualified tables", () => {
    const sql = `
      WITH active_users AS (
        SELECT id, name FROM myschema.users WHERE status = 'active'
      )
      SELECT 
        au.id,
        au.name,
        o.total
      FROM active_users au
      JOIN orders_schema.orders o ON au.id = o.user_id
    `;
    const ast = parseSQL(sql);
    const namespace = createNamespace("trino", [
      createTable("myschema.users", ["id", "name", "status"]),
      createTable("orders_schema.orders", ["id", "user_id", "total"]),
    ]);

    const lineage = getExtendedLineage(ast as Select, namespace);

    expect(lineage.fields).toEqual({
      id: {
        inputFields: [
          {
            name: "myschema.users",
            namespace: "trino",
            field: "id",
            transformations: [DIRECT_IDENTITY],
          },
        ],
      },
      name: {
        inputFields: [
          {
            name: "myschema.users",
            namespace: "trino",
            field: "name",
            transformations: [DIRECT_IDENTITY],
          },
        ],
      },
      total: {
        inputFields: [
          {
            name: "orders_schema.orders",
            namespace: "trino",
            field: "total",
            transformations: [DIRECT_IDENTITY],
          },
        ],
      },
    });
  });

  test("select * from schema-qualified table", () => {
    const sql = `SELECT * FROM myschema.users`;
    const ast = parseSQL(sql);
    const namespace = createNamespace("trino", [createTable("myschema.users", ["id", "name", "email"])]);

    const lineage = getExtendedLineage(ast as Select, namespace);

    expect(lineage.fields).toEqual({
      id: {
        inputFields: [
          {
            name: "myschema.users",
            namespace: "trino",
            field: "id",
            transformations: [DIRECT_IDENTITY],
          },
        ],
      },
      name: {
        inputFields: [
          {
            name: "myschema.users",
            namespace: "trino",
            field: "name",
            transformations: [DIRECT_IDENTITY],
          },
        ],
      },
      email: {
        inputFields: [
          {
            name: "myschema.users",
            namespace: "trino",
            field: "email",
            transformations: [DIRECT_IDENTITY],
          },
        ],
      },
    });
  });
});

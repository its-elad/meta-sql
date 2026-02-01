import { describe, test, expect } from "bun:test";
import { Parser } from "node-sql-parser";
import type { AST, Select } from "node-sql-parser";
import {
  getExtendedLineage,
  type Schema,
  type Table,
  INDIRECT_JOIN,
  INDIRECT_FILTER,
  INDIRECT_GROUP_BY,
  INDIRECT_SORT,
  INDIRECT_WINDOW,
  DIRECT_IDENTITY,
  DIRECT_TRANSFORMATION,
  DIRECT_AGGREGATION,
} from "../src/index.js";

const parser = new Parser();

// Helper function to create schemas
function createSchema(namespace: string, tables: Table[]): Schema {
  return { namespace, tables };
}

function createTable(name: string, columns: string[]): Table {
  return { name, columns };
}

// Helper to ensure we get a single AST
function parseSQL(sql: string): AST {
  const result = parser.astify(sql, { database: "trino" });
  const ast = Array.isArray(result) ? result[0] : result;

  if (!ast) {
    throw new Error("Failed to parse SQL");
  }

  return ast;
}

// Helper to find dataset lineage entries by transformation subtype
function findBySubtype(dataset: ReturnType<typeof getExtendedLineage>["dataset"], subtype: string) {
  return dataset?.filter((f) => f.transformations?.[0]?.subtype === subtype) ?? [];
}

// Helper to find dataset lineage entry by field name and subtype
function findFieldBySubtype(
  dataset: ReturnType<typeof getExtendedLineage>["dataset"],
  fieldName: string,
  subtype: string,
) {
  return dataset?.find((f) => f.field === fieldName && f.transformations?.[0]?.subtype === subtype);
}

// =============================================================================
// SIMPLE TESTS - Single Clause Scenarios
// =============================================================================

describe("getExtendedLineage - Simple SELECT (no indirect lineage)", () => {
  test("simple select without any indirect clauses", () => {
    const sql = `SELECT id, name FROM users`;

    const ast = parseSQL(sql);
    const schema = createSchema("trino", [createTable("users", ["id", "name", "email"])]);

    const result = getExtendedLineage(ast as Select, schema);

    // Field-level lineage should exist
    expect(result.fields.id).toBeDefined();
    expect(result.fields.name).toBeDefined();
    expect(result.fields.id?.inputFields).toContainEqual({
      namespace: "trino",
      name: "users",
      field: "id",
      transformations: [DIRECT_IDENTITY],
    });
    expect(result.fields.name?.inputFields).toContainEqual({
      namespace: "trino",
      name: "users",
      field: "name",
      transformations: [DIRECT_IDENTITY],
    });

    // Dataset-level lineage should be empty
    expect(result.dataset).toEqual([]);
  });

  test("select with alias", () => {
    const sql = `SELECT id as user_id, name as user_name FROM users`;

    const ast = parseSQL(sql);
    const schema = createSchema("trino", [createTable("users", ["id", "name"])]);

    const result = getExtendedLineage(ast as Select, schema);

    expect(result.fields.user_id?.inputFields).toContainEqual({
      namespace: "trino",
      name: "users",
      field: "id",
      transformations: [DIRECT_IDENTITY],
    });
    expect(result.fields.user_name?.inputFields).toContainEqual({
      namespace: "trino",
      name: "users",
      field: "name",
      transformations: [DIRECT_IDENTITY],
    });
    expect(result.dataset).toEqual([]);
  });
});

describe("getExtendedLineage - JOIN only", () => {
  test("simple INNER JOIN", () => {
    const sql = `
      SELECT u.id, u.name, o.total
      FROM users u
      JOIN orders o ON u.id = o.user_id
    `;

    const ast = parseSQL(sql);
    const schema = createSchema("trino", [
      createTable("users", ["id", "name"]),
      createTable("orders", ["id", "user_id", "total"]),
    ]);

    const result = getExtendedLineage(ast as Select, schema);

    // Field-level lineage
    expect(result.fields.id?.inputFields).toContainEqual({
      namespace: "trino",
      name: "users",
      field: "id",
      transformations: [DIRECT_IDENTITY],
    });

    // Dataset-level lineage - JOIN
    const joinLineage = findBySubtype(result.dataset, "JOIN");
    expect(joinLineage.length).toBe(2);
    expect(joinLineage).toContainEqual({
      namespace: "trino",
      name: "users",
      field: "id",
      transformations: [INDIRECT_JOIN],
    });
    expect(joinLineage).toContainEqual({
      namespace: "trino",
      name: "orders",
      field: "user_id",
      transformations: [INDIRECT_JOIN],
    });
  });

  test("LEFT JOIN", () => {
    const sql = `
      SELECT u.id, o.total
      FROM users u
      LEFT JOIN orders o ON u.id = o.user_id
    `;

    const ast = parseSQL(sql);
    const schema = createSchema("trino", [
      createTable("users", ["id", "name"]),
      createTable("orders", ["id", "user_id", "total"]),
    ]);

    const result = getExtendedLineage(ast as Select, schema);

    const joinLineage = findBySubtype(result.dataset, "JOIN");
    expect(joinLineage.length).toBe(2);
  });

  test("RIGHT JOIN", () => {
    const sql = `
      SELECT u.id, o.total
      FROM users u
      RIGHT JOIN orders o ON u.id = o.user_id
    `;

    const ast = parseSQL(sql);
    const schema = createSchema("trino", [
      createTable("users", ["id", "name"]),
      createTable("orders", ["id", "user_id", "total"]),
    ]);

    const result = getExtendedLineage(ast as Select, schema);

    const joinLineage = findBySubtype(result.dataset, "JOIN");
    expect(joinLineage.length).toBe(2);
  });

  test("FULL OUTER JOIN", () => {
    const sql = `
      SELECT u.id, u.name, o.total
      FROM users u
      FULL OUTER JOIN orders o ON u.id = o.user_id
    `;

    const ast = parseSQL(sql);
    const schema = createSchema("trino", [
      createTable("users", ["id", "name"]),
      createTable("orders", ["id", "user_id", "total"]),
    ]);

    const result = getExtendedLineage(ast as Select, schema);

    // Field-level lineage
    expect(result.fields.id?.inputFields).toContainEqual({
      namespace: "trino",
      name: "users",
      field: "id",
      transformations: [DIRECT_IDENTITY],
    });
    expect(result.fields.name?.inputFields).toContainEqual({
      namespace: "trino",
      name: "users",
      field: "name",
      transformations: [DIRECT_IDENTITY],
    });
    expect(result.fields.total?.inputFields).toContainEqual({
      namespace: "trino",
      name: "orders",
      field: "total",
      transformations: [DIRECT_IDENTITY],
    });

    // Dataset-level lineage - JOIN columns from both tables
    const joinLineage = findBySubtype(result.dataset, "JOIN");
    expect(joinLineage.length).toBe(2);
    expect(joinLineage).toContainEqual({
      namespace: "trino",
      name: "users",
      field: "id",
      transformations: [INDIRECT_JOIN],
    });
    expect(joinLineage).toContainEqual({
      namespace: "trino",
      name: "orders",
      field: "user_id",
      transformations: [INDIRECT_JOIN],
    });
  });

  test("FULL JOIN (shorthand)", () => {
    const sql = `
      SELECT u.id, o.total
      FROM users u
      FULL JOIN orders o ON u.id = o.user_id
    `;

    const ast = parseSQL(sql);
    const schema = createSchema("trino", [
      createTable("users", ["id", "name"]),
      createTable("orders", ["id", "user_id", "total"]),
    ]);

    const result = getExtendedLineage(ast as Select, schema);

    const joinLineage = findBySubtype(result.dataset, "JOIN");
    expect(joinLineage.length).toBe(2);
  });

  test("FULL OUTER JOIN with complex ON condition", () => {
    const sql = `
      SELECT u.id, u.name, o.total
      FROM users u
      FULL OUTER JOIN orders o ON u.id = o.user_id AND u.region = o.region
    `;

    const ast = parseSQL(sql);
    const schema = createSchema("trino", [
      createTable("users", ["id", "name", "region"]),
      createTable("orders", ["id", "user_id", "region", "total"]),
    ]);

    const result = getExtendedLineage(ast as Select, schema);

    const joinLineage = findBySubtype(result.dataset, "JOIN");
    expect(joinLineage.length).toBe(4); // u.id, o.user_id, u.region, o.region
    expect(joinLineage).toContainEqual({
      namespace: "trino",
      name: "users",
      field: "id",
      transformations: [INDIRECT_JOIN],
    });
    expect(joinLineage).toContainEqual({
      namespace: "trino",
      name: "orders",
      field: "user_id",
      transformations: [INDIRECT_JOIN],
    });
    expect(joinLineage).toContainEqual({
      namespace: "trino",
      name: "users",
      field: "region",
      transformations: [INDIRECT_JOIN],
    });
    expect(joinLineage).toContainEqual({
      namespace: "trino",
      name: "orders",
      field: "region",
      transformations: [INDIRECT_JOIN],
    });
  });

  test("FULL OUTER JOIN with WHERE clause", () => {
    const sql = `
      SELECT u.id, u.name, o.total
      FROM users u
      FULL OUTER JOIN orders o ON u.id = o.user_id
      WHERE u.status = 'active' OR o.status = 'completed'
    `;

    const ast = parseSQL(sql);
    const schema = createSchema("trino", [
      createTable("users", ["id", "name", "status"]),
      createTable("orders", ["id", "user_id", "status", "total"]),
    ]);

    const result = getExtendedLineage(ast as Select, schema);

    // JOIN lineage
    const joinLineage = findBySubtype(result.dataset, "JOIN");
    expect(joinLineage.length).toBe(2);

    // FILTER lineage from WHERE clause
    const filterLineage = findBySubtype(result.dataset, "FILTER");
    expect(filterLineage.length).toBe(2);
    expect(filterLineage).toContainEqual({
      namespace: "trino",
      name: "users",
      field: "status",
      transformations: [INDIRECT_FILTER],
    });
    expect(filterLineage).toContainEqual({
      namespace: "trino",
      name: "orders",
      field: "status",
      transformations: [INDIRECT_FILTER],
    });
  });

  test("CROSS JOIN", () => {
    const sql = `
      SELECT u.id, u.name, p.name as product_name
      FROM users u
      CROSS JOIN products p
    `;

    const ast = parseSQL(sql);
    const schema = createSchema("trino", [
      createTable("users", ["id", "name"]),
      createTable("products", ["id", "name"]),
    ]);

    const result = getExtendedLineage(ast as Select, schema);

    // Field-level lineage should work correctly
    expect(result.fields.id?.inputFields).toContainEqual({
      namespace: "trino",
      name: "users",
      field: "id",
      transformations: [DIRECT_IDENTITY],
    });
    expect(result.fields.name?.inputFields).toContainEqual({
      namespace: "trino",
      name: "users",
      field: "name",
      transformations: [DIRECT_IDENTITY],
    });
    expect(result.fields.product_name?.inputFields).toContainEqual({
      namespace: "trino",
      name: "products",
      field: "name",
      transformations: [DIRECT_IDENTITY],
    });

    // CROSS JOIN has no ON clause, so no JOIN lineage in dataset
    const joinLineage = findBySubtype(result.dataset, "JOIN");
    expect(joinLineage.length).toBe(0);
  });

  test("CROSS JOIN with WHERE clause", () => {
    const sql = `
      SELECT u.id, u.name, p.name as product_name
      FROM users u
      CROSS JOIN products p
      WHERE u.status = 'active' AND p.category = 'electronics'
    `;

    const ast = parseSQL(sql);
    const schema = createSchema("trino", [
      createTable("users", ["id", "name", "status"]),
      createTable("products", ["id", "name", "category"]),
    ]);

    const result = getExtendedLineage(ast as Select, schema);

    // CROSS JOIN has no ON clause, so no JOIN lineage
    const joinLineage = findBySubtype(result.dataset, "JOIN");
    expect(joinLineage.length).toBe(0);

    // FILTER lineage from WHERE clause should be captured
    const filterLineage = findBySubtype(result.dataset, "FILTER");
    expect(filterLineage.length).toBe(2);
    expect(filterLineage).toContainEqual({
      namespace: "trino",
      name: "users",
      field: "status",
      transformations: [INDIRECT_FILTER],
    });
    expect(filterLineage).toContainEqual({
      namespace: "trino",
      name: "products",
      field: "category",
      transformations: [INDIRECT_FILTER],
    });
  });

  test("CROSS JOIN combined with regular JOIN", () => {
    const sql = `
      SELECT u.id, o.total, p.name as product_name
      FROM users u
      JOIN orders o ON u.id = o.user_id
      CROSS JOIN products p
    `;

    const ast = parseSQL(sql);
    const schema = createSchema("trino", [
      createTable("users", ["id", "name"]),
      createTable("orders", ["id", "user_id", "total"]),
      createTable("products", ["id", "name"]),
    ]);

    const result = getExtendedLineage(ast as Select, schema);

    // Field-level lineage
    expect(result.fields.id?.inputFields).toContainEqual({
      namespace: "trino",
      name: "users",
      field: "id",
      transformations: [DIRECT_IDENTITY],
    });
    expect(result.fields.total?.inputFields).toContainEqual({
      namespace: "trino",
      name: "orders",
      field: "total",
      transformations: [DIRECT_IDENTITY],
    });
    expect(result.fields.product_name?.inputFields).toContainEqual({
      namespace: "trino",
      name: "products",
      field: "name",
      transformations: [DIRECT_IDENTITY],
    });

    // JOIN lineage only from the regular JOIN (not CROSS JOIN)
    const joinLineage = findBySubtype(result.dataset, "JOIN");
    expect(joinLineage.length).toBe(2);
    expect(joinLineage).toContainEqual({
      namespace: "trino",
      name: "users",
      field: "id",
      transformations: [INDIRECT_JOIN],
    });
    expect(joinLineage).toContainEqual({
      namespace: "trino",
      name: "orders",
      field: "user_id",
      transformations: [INDIRECT_JOIN],
    });
  });

  test("implicit CROSS JOIN (comma syntax)", () => {
    const sql = `
      SELECT u.id, u.name, p.name as product_name
      FROM users u, products p
    `;

    const ast = parseSQL(sql);
    const schema = createSchema("trino", [
      createTable("users", ["id", "name"]),
      createTable("products", ["id", "name"]),
    ]);

    const result = getExtendedLineage(ast as Select, schema);

    // Field-level lineage should work correctly
    expect(result.fields.id?.inputFields).toContainEqual({
      namespace: "trino",
      name: "users",
      field: "id",
      transformations: [DIRECT_IDENTITY],
    });
    expect(result.fields.product_name?.inputFields).toContainEqual({
      namespace: "trino",
      name: "products",
      field: "name",
      transformations: [DIRECT_IDENTITY],
    });

    // No JOIN lineage since implicit cross join has no ON clause
    const joinLineage = findBySubtype(result.dataset, "JOIN");
    expect(joinLineage.length).toBe(0);
  });

  test("implicit CROSS JOIN with WHERE acting as JOIN condition", () => {
    const sql = `
      SELECT u.id, o.total
      FROM users u, orders o
      WHERE u.id = o.user_id
    `;

    const ast = parseSQL(sql);
    const schema = createSchema("trino", [
      createTable("users", ["id", "name"]),
      createTable("orders", ["id", "user_id", "total"]),
    ]);

    const result = getExtendedLineage(ast as Select, schema);

    // Field-level lineage
    expect(result.fields.id?.inputFields).toContainEqual({
      namespace: "trino",
      name: "users",
      field: "id",
      transformations: [DIRECT_IDENTITY],
    });
    expect(result.fields.total?.inputFields).toContainEqual({
      namespace: "trino",
      name: "orders",
      field: "total",
      transformations: [DIRECT_IDENTITY],
    });

    // No JOIN lineage (CROSS JOIN has no ON clause)
    const joinLineage = findBySubtype(result.dataset, "JOIN");
    expect(joinLineage.length).toBe(0);

    // The WHERE condition is captured as FILTER lineage
    const filterLineage = findBySubtype(result.dataset, "FILTER");
    expect(filterLineage.length).toBe(2);
    expect(filterLineage).toContainEqual({
      namespace: "trino",
      name: "users",
      field: "id",
      transformations: [INDIRECT_FILTER],
    });
    expect(filterLineage).toContainEqual({
      namespace: "trino",
      name: "orders",
      field: "user_id",
      transformations: [INDIRECT_FILTER],
    });
  });

  test("multiple JOINs", () => {
    const sql = `
      SELECT u.name, o.total, p.name as product_name
      FROM users u
      JOIN orders o ON u.id = o.user_id
      JOIN products p ON o.product_id = p.id
    `;

    const ast = parseSQL(sql);
    const schema = createSchema("trino", [
      createTable("users", ["id", "name"]),
      createTable("orders", ["id", "user_id", "product_id", "total"]),
      createTable("products", ["id", "name"]),
    ]);

    const result = getExtendedLineage(ast as Select, schema);

    const joinLineage = findBySubtype(result.dataset, "JOIN");
    expect(joinLineage.length).toBe(4); // u.id, o.user_id, o.product_id, p.id
  });

  test("JOIN with complex ON condition", () => {
    const sql = `
      SELECT u.id, o.total
      FROM users u
      JOIN orders o ON u.id = o.user_id AND u.status = o.status
    `;

    const ast = parseSQL(sql);
    const schema = createSchema("trino", [
      createTable("users", ["id", "status"]),
      createTable("orders", ["id", "user_id", "status", "total"]),
    ]);

    const result = getExtendedLineage(ast as Select, schema);

    const joinLineage = findBySubtype(result.dataset, "JOIN");
    expect(joinLineage.length).toBe(4); // u.id, o.user_id, u.status, o.status
  });

  test("self JOIN", () => {
    const sql = `
      SELECT e.name as employee, m.name as manager
      FROM employees e
      JOIN employees m ON e.manager_id = m.id
    `;

    const ast = parseSQL(sql);
    const schema = createSchema("trino", [createTable("employees", ["id", "name", "manager_id"])]);

    const result = getExtendedLineage(ast as Select, schema);

    const joinLineage = findBySubtype(result.dataset, "JOIN");
    expect(joinLineage.length).toBeGreaterThanOrEqual(2);
  });
});

describe("getExtendedLineage - WHERE only (FILTER)", () => {
  test("simple WHERE clause", () => {
    const sql = `
      SELECT id, name
      FROM users
      WHERE status = 'active'
    `;

    const ast = parseSQL(sql);
    const schema = createSchema("trino", [createTable("users", ["id", "name", "status"])]);

    const result = getExtendedLineage(ast as Select, schema);

    const filterLineage = findBySubtype(result.dataset, "FILTER");
    expect(filterLineage.length).toBe(1);
    expect(filterLineage).toContainEqual({
      namespace: "trino",
      name: "users",
      field: "status",
      transformations: [INDIRECT_FILTER],
    });
  });

  test("WHERE with AND", () => {
    const sql = `
      SELECT id, name
      FROM users
      WHERE status = 'active' AND age > 18
    `;

    const ast = parseSQL(sql);
    const schema = createSchema("trino", [createTable("users", ["id", "name", "status", "age"])]);

    const result = getExtendedLineage(ast as Select, schema);

    const filterLineage = findBySubtype(result.dataset, "FILTER");
    expect(filterLineage.length).toBe(2);
    expect(filterLineage).toContainEqual({
      namespace: "trino",
      name: "users",
      field: "status",
      transformations: [INDIRECT_FILTER],
    });
    expect(filterLineage).toContainEqual({
      namespace: "trino",
      name: "users",
      field: "age",
      transformations: [INDIRECT_FILTER],
    });
  });

  test("WHERE with OR", () => {
    const sql = `
      SELECT id, name
      FROM users
      WHERE status = 'active' OR country = 'US'
    `;

    const ast = parseSQL(sql);
    const schema = createSchema("trino", [createTable("users", ["id", "name", "status", "country"])]);

    const result = getExtendedLineage(ast as Select, schema);

    const filterLineage = findBySubtype(result.dataset, "FILTER");
    expect(filterLineage.length).toBe(2);
  });

  test("WHERE with complex nested conditions", () => {
    const sql = `
      SELECT id, name
      FROM users
      WHERE (status = 'active' AND age > 18) OR (country = 'US' AND verified = true)
    `;

    const ast = parseSQL(sql);
    const schema = createSchema("trino", [
      createTable("users", ["id", "name", "status", "age", "country", "verified"]),
    ]);

    const result = getExtendedLineage(ast as Select, schema);

    const filterLineage = findBySubtype(result.dataset, "FILTER");
    expect(filterLineage.length).toBe(4);
  });

  test("WHERE with IN clause", () => {
    const sql = `
      SELECT id, name
      FROM users
      WHERE country IN ('US', 'UK', 'CA')
    `;

    const ast = parseSQL(sql);
    const schema = createSchema("trino", [createTable("users", ["id", "name", "country"])]);

    const result = getExtendedLineage(ast as Select, schema);

    const filterLineage = findBySubtype(result.dataset, "FILTER");
    expect(filterLineage.length).toBe(1);
    expect(filterLineage).toContainEqual({
      namespace: "trino",
      name: "users",
      field: "country",
      transformations: [INDIRECT_FILTER],
    });
  });

  test("WHERE with BETWEEN", () => {
    const sql = `
      SELECT id, name
      FROM users
      WHERE age BETWEEN 18 AND 65
    `;

    const ast = parseSQL(sql);
    const schema = createSchema("trino", [createTable("users", ["id", "name", "age"])]);

    const result = getExtendedLineage(ast as Select, schema);

    const filterLineage = findBySubtype(result.dataset, "FILTER");
    expect(filterLineage.length).toBe(1);
  });

  test("WHERE with LIKE", () => {
    const sql = `
      SELECT id, name
      FROM users
      WHERE name LIKE 'John%'
    `;

    const ast = parseSQL(sql);
    const schema = createSchema("trino", [createTable("users", ["id", "name"])]);

    const result = getExtendedLineage(ast as Select, schema);

    const filterLineage = findBySubtype(result.dataset, "FILTER");
    expect(filterLineage.length).toBe(1);
  });

  test("WHERE with IS NULL", () => {
    const sql = `
      SELECT id, name
      FROM users
      WHERE email IS NULL
    `;

    const ast = parseSQL(sql);
    const schema = createSchema("trino", [createTable("users", ["id", "name", "email"])]);

    const result = getExtendedLineage(ast as Select, schema);

    const filterLineage = findBySubtype(result.dataset, "FILTER");
    expect(filterLineage.length).toBe(1);
  });
});

describe("getExtendedLineage - GROUP BY only", () => {
  test("simple GROUP BY", () => {
    const sql = `
      SELECT country, COUNT(*) as count
      FROM users
      GROUP BY country
    `;

    const ast = parseSQL(sql);
    const schema = createSchema("trino", [createTable("users", ["id", "name", "country"])]);

    const result = getExtendedLineage(ast as Select, schema);

    const groupByLineage = findBySubtype(result.dataset, "GROUP_BY");
    expect(groupByLineage.length).toBe(1);
    expect(groupByLineage).toContainEqual({
      namespace: "trino",
      name: "users",
      field: "country",
      transformations: [INDIRECT_GROUP_BY],
    });
  });

  test("multiple GROUP BY columns", () => {
    const sql = `
      SELECT country, city, COUNT(*) as count
      FROM users
      GROUP BY country, city
    `;

    const ast = parseSQL(sql);
    const schema = createSchema("trino", [createTable("users", ["id", "name", "country", "city"])]);

    const result = getExtendedLineage(ast as Select, schema);

    const groupByLineage = findBySubtype(result.dataset, "GROUP_BY");
    expect(groupByLineage.length).toBe(2);
    expect(groupByLineage).toContainEqual({
      namespace: "trino",
      name: "users",
      field: "country",
      transformations: [INDIRECT_GROUP_BY],
    });
    expect(groupByLineage).toContainEqual({
      namespace: "trino",
      name: "users",
      field: "city",
      transformations: [INDIRECT_GROUP_BY],
    });
  });

  test("GROUP BY with aggregation functions", () => {
    const sql = `
      SELECT 
        department,
        SUM(salary) as total_salary,
        AVG(age) as avg_age,
        MIN(hire_date) as first_hire
      FROM employees
      GROUP BY department
    `;

    const ast = parseSQL(sql);
    const schema = createSchema("trino", [
      createTable("employees", ["id", "department", "salary", "age", "hire_date"]),
    ]);

    const result = getExtendedLineage(ast as Select, schema);

    // Field-level lineage should show aggregations
    expect(result.fields.total_salary?.inputFields).toContainEqual({
      namespace: "trino",
      name: "employees",
      field: "salary",
      transformations: [DIRECT_AGGREGATION],
    });

    // Dataset-level lineage should show GROUP_BY
    const groupByLineage = findBySubtype(result.dataset, "GROUP_BY");
    expect(groupByLineage.length).toBe(1);
    expect(groupByLineage).toContainEqual({
      namespace: "trino",
      name: "employees",
      field: "department",
      transformations: [INDIRECT_GROUP_BY],
    });
  });
});

describe("getExtendedLineage - ORDER BY only (SORT)", () => {
  test("simple ORDER BY", () => {
    const sql = `
      SELECT id, name
      FROM users
      ORDER BY created_at DESC
    `;

    const ast = parseSQL(sql);
    const schema = createSchema("trino", [createTable("users", ["id", "name", "created_at"])]);

    const result = getExtendedLineage(ast as Select, schema);

    const sortLineage = findBySubtype(result.dataset, "SORT");
    expect(sortLineage.length).toBe(1);
    expect(sortLineage).toContainEqual({
      namespace: "trino",
      name: "users",
      field: "created_at",
      transformations: [INDIRECT_SORT],
    });
  });

  test("multiple ORDER BY columns", () => {
    const sql = `
      SELECT id, name
      FROM users
      ORDER BY country ASC, name DESC
    `;

    const ast = parseSQL(sql);
    const schema = createSchema("trino", [createTable("users", ["id", "name", "country"])]);

    const result = getExtendedLineage(ast as Select, schema);

    const sortLineage = findBySubtype(result.dataset, "SORT");
    expect(sortLineage.length).toBe(2);
    expect(sortLineage).toContainEqual({
      namespace: "trino",
      name: "users",
      field: "country",
      transformations: [INDIRECT_SORT],
    });
    expect(sortLineage).toContainEqual({
      namespace: "trino",
      name: "users",
      field: "name",
      transformations: [INDIRECT_SORT],
    });
  });

  test("ORDER BY with NULLS FIRST/LAST", () => {
    const sql = `
      SELECT id, name
      FROM users
      ORDER BY email NULLS LAST
    `;

    const ast = parseSQL(sql);
    const schema = createSchema("trino", [createTable("users", ["id", "name", "email"])]);

    const result = getExtendedLineage(ast as Select, schema);

    const sortLineage = findBySubtype(result.dataset, "SORT");
    expect(sortLineage.length).toBe(1);
  });

  test("ORDER BY alias resolves to base column", () => {
    const sql = `
      SELECT country, SUM(revenue) as total_revenue
      FROM orders
      GROUP BY country
      ORDER BY total_revenue DESC
    `;

    const ast = parseSQL(sql);
    const schema = createSchema("trino", [createTable("orders", ["id", "country", "revenue"])]);

    const result = getExtendedLineage(ast as Select, schema);

    // ORDER BY total_revenue should resolve to the base column 'revenue' used in SUM(revenue)
    const sortLineage = findBySubtype(result.dataset, "SORT");
    expect(sortLineage.length).toBe(1);
    expect(sortLineage).toContainEqual({
      namespace: "trino",
      name: "orders",
      field: "revenue",
      transformations: [INDIRECT_SORT],
    });
  });

  test("ORDER BY alias with multiple columns in expression", () => {
    const sql = `
      SELECT product_id, (quantity * price) as total_value
      FROM order_items
      ORDER BY total_value DESC
    `;

    const ast = parseSQL(sql);
    const schema = createSchema("trino", [createTable("order_items", ["id", "product_id", "quantity", "price"])]);

    const result = getExtendedLineage(ast as Select, schema);

    // ORDER BY total_value should resolve to both 'quantity' and 'price' columns
    const sortLineage = findBySubtype(result.dataset, "SORT");
    expect(sortLineage.length).toBe(2);
    expect(sortLineage).toContainEqual({
      namespace: "trino",
      name: "order_items",
      field: "quantity",
      transformations: [INDIRECT_SORT],
    });
    expect(sortLineage).toContainEqual({
      namespace: "trino",
      name: "order_items",
      field: "price",
      transformations: [INDIRECT_SORT],
    });
  });

  test("ORDER BY with mix of alias and direct column references", () => {
    const sql = `
      SELECT country, SUM(revenue) as total_revenue
      FROM orders
      GROUP BY country
      ORDER BY country ASC, total_revenue DESC
    `;

    const ast = parseSQL(sql);
    const schema = createSchema("trino", [createTable("orders", ["id", "country", "revenue"])]);

    const result = getExtendedLineage(ast as Select, schema);

    const sortLineage = findBySubtype(result.dataset, "SORT");
    expect(sortLineage.length).toBe(2);
    expect(sortLineage).toContainEqual({
      namespace: "trino",
      name: "orders",
      field: "country",
      transformations: [INDIRECT_SORT],
    });
    expect(sortLineage).toContainEqual({
      namespace: "trino",
      name: "orders",
      field: "revenue",
      transformations: [INDIRECT_SORT],
    });
  });
});

describe("getExtendedLineage - HAVING only", () => {
  test("simple HAVING clause", () => {
    const sql = `
      SELECT country, COUNT(*) as count
      FROM users
      GROUP BY country
      HAVING COUNT(*) > 10
    `;

    const ast = parseSQL(sql);
    const schema = createSchema("trino", [createTable("users", ["id", "name", "country"])]);

    const result = getExtendedLineage(ast as Select, schema);

    // GROUP BY lineage
    const groupByLineage = findBySubtype(result.dataset, "GROUP_BY");
    expect(groupByLineage.length).toBe(1);

    // Note: COUNT(*) doesn't reference a specific column, so HAVING may not add to dataset
  });

  test("HAVING with column reference", () => {
    const sql = `
      SELECT department, SUM(salary) as total_salary
      FROM employees
      GROUP BY department
      HAVING SUM(salary) > 100000
    `;

    const ast = parseSQL(sql);
    const schema = createSchema("trino", [createTable("employees", ["id", "department", "salary"])]);

    const result = getExtendedLineage(ast as Select, schema);

    // Should have GROUP_BY
    const groupByLineage = findBySubtype(result.dataset, "GROUP_BY");
    expect(groupByLineage.length).toBe(1);

    // HAVING filters should show as FILTER
    const filterLineage = findBySubtype(result.dataset, "FILTER");
    expect(filterLineage).toContainEqual({
      namespace: "trino",
      name: "employees",
      field: "salary",
      transformations: [INDIRECT_FILTER],
    });
  });

  test("HAVING with multiple conditions", () => {
    const sql = `
      SELECT department, AVG(age) as avg_age
      FROM employees
      GROUP BY department
      HAVING AVG(age) > 30 AND COUNT(id) > 5
    `;

    const ast = parseSQL(sql);
    const schema = createSchema("trino", [createTable("employees", ["id", "department", "age"])]);

    const result = getExtendedLineage(ast as Select, schema);

    const filterLineage = findBySubtype(result.dataset, "FILTER");
    expect(filterLineage.length).toBeGreaterThanOrEqual(1);
  });
});

describe("getExtendedLineage - WINDOW functions", () => {
  test("window function with PARTITION BY and ORDER BY - full lineage captured", () => {
    const sql = `
      SELECT 
        id,
        department,
        SUM(salary) OVER (PARTITION BY department ORDER BY salary DESC) as running_total
      FROM employees
    `;

    const ast = parseSQL(sql);
    const schema = createSchema("trino", [createTable("employees", ["id", "department", "salary"])]);

    const result = getExtendedLineage(ast as Select, schema);

    // Field-level lineage is captured correctly
    expect(result.fields.id?.inputFields).toContainEqual({
      namespace: "trino",
      name: "employees",
      field: "id",
      transformations: [DIRECT_IDENTITY],
    });
    expect(result.fields.department?.inputFields).toContainEqual({
      namespace: "trino",
      name: "employees",
      field: "department",
      transformations: [DIRECT_IDENTITY],
    });
    // The aggregated column in window function is captured
    expect(result.fields.running_total?.inputFields).toContainEqual({
      namespace: "trino",
      name: "employees",
      field: "salary",
      transformations: [DIRECT_AGGREGATION],
    });

    // Dataset-level WINDOW lineage from PARTITION BY and ORDER BY
    const windowLineage = findBySubtype(result.dataset, "WINDOW");
    expect(windowLineage.length).toBe(2);
    expect(windowLineage).toContainEqual({
      namespace: "trino",
      name: "employees",
      field: "department",
      transformations: [INDIRECT_WINDOW],
    });
    expect(windowLineage).toContainEqual({
      namespace: "trino",
      name: "employees",
      field: "salary",
      transformations: [INDIRECT_WINDOW],
    });
  });

  test("window function with filter - combined lineage", () => {
    const sql = `
      SELECT 
        id,
        SUM(amount) OVER (ORDER BY date) as running_total
      FROM transactions
      WHERE status = 'completed'
    `;

    const ast = parseSQL(sql);
    const schema = createSchema("trino", [createTable("transactions", ["id", "amount", "date", "status"])]);

    const result = getExtendedLineage(ast as Select, schema);

    // WINDOW lineage from ORDER BY in OVER clause
    const windowLineage = findBySubtype(result.dataset, "WINDOW");
    expect(windowLineage.length).toBe(1);
    expect(windowLineage).toContainEqual({
      namespace: "trino",
      name: "transactions",
      field: "date",
      transformations: [INDIRECT_WINDOW],
    });

    // FILTER lineage from WHERE is captured
    const filterLineage = findBySubtype(result.dataset, "FILTER");
    expect(filterLineage).toContainEqual({
      namespace: "trino",
      name: "transactions",
      field: "status",
      transformations: [INDIRECT_FILTER],
    });
  });

  test("multiple window functions", () => {
    const sql = `
      SELECT 
        id,
        ROW_NUMBER() OVER (PARTITION BY category ORDER BY created_at) as row_num,
        SUM(amount) OVER (PARTITION BY user_id ORDER BY created_at) as running_total
      FROM orders
    `;

    const ast = parseSQL(sql);
    const schema = createSchema("trino", [createTable("orders", ["id", "category", "created_at", "amount", "user_id"])]);

    const result = getExtendedLineage(ast as Select, schema);

    const windowLineage = findBySubtype(result.dataset, "WINDOW");
    // category, created_at (from first window), user_id, created_at (from second window)
    // created_at should be deduplicated
    expect(windowLineage.length).toBe(3);
    expect(windowLineage).toContainEqual({
      namespace: "trino",
      name: "orders",
      field: "category",
      transformations: [INDIRECT_WINDOW],
    });
    expect(windowLineage).toContainEqual({
      namespace: "trino",
      name: "orders",
      field: "user_id",
      transformations: [INDIRECT_WINDOW],
    });
    expect(windowLineage).toContainEqual({
      namespace: "trino",
      name: "orders",
      field: "created_at",
      transformations: [INDIRECT_WINDOW],
    });
  });
});

describe("getExtendedLineage - CASE expressions (CONDITION)", () => {
  test("simple CASE WHEN", () => {
    const sql = `
      SELECT 
        id,
        CASE 
          WHEN status = 'active' THEN 'Active'
          ELSE 'Inactive'
        END as status_label
      FROM users
    `;

    const ast = parseSQL(sql);
    const schema = createSchema("trino", [createTable("users", ["id", "status"])]);

    const result = getExtendedLineage(ast as Select, schema);

    // Field-level lineage should contain the status column with CONDITION
    expect(result.fields.status_label).toBeDefined();
    const hasConditionOrTransformation = result.fields.status_label?.inputFields.some(
      (f) =>
        f.transformations?.some((t) => t.subtype === "CONDITION") ||
        f.transformations?.some((t) => t.subtype === "TRANSFORMATION"),
    );
    expect(hasConditionOrTransformation).toBe(true);
  });

  test("CASE with multiple conditions", () => {
    const sql = `
      SELECT 
        id,
        CASE 
          WHEN age < 18 THEN 'Minor'
          WHEN age < 65 THEN 'Adult'
          ELSE 'Senior'
        END as age_group
      FROM users
    `;

    const ast = parseSQL(sql);
    const schema = createSchema("trino", [createTable("users", ["id", "age"])]);

    const result = getExtendedLineage(ast as Select, schema);

    expect(result.fields.age_group).toBeDefined();
    expect(result.fields.age_group?.inputFields.length).toBeGreaterThan(0);
  });

  test("CASE with column in result", () => {
    const sql = `
      SELECT 
        id,
        CASE 
          WHEN discount_type = 'percent' THEN price * (1 - discount_value / 100)
          ELSE price - discount_value
        END as final_price
      FROM products
    `;

    const ast = parseSQL(sql);
    const schema = createSchema("trino", [createTable("products", ["id", "price", "discount_type", "discount_value"])]);

    const result = getExtendedLineage(ast as Select, schema);

    const inputFields = result.fields.final_price?.inputFields.map((f) => f.field);
    expect(inputFields).toContain("price");
    expect(inputFields).toContain("discount_type");
    expect(inputFields).toContain("discount_value");
  });
});

// =============================================================================
// COMPLEX TESTS - Multiple Clauses Combined
// =============================================================================

describe("getExtendedLineage - JOIN + WHERE", () => {
  test("JOIN with WHERE filter", () => {
    const sql = `
      SELECT u.id, u.name, o.total
      FROM users u
      JOIN orders o ON u.id = o.user_id
      WHERE u.status = 'active' AND o.total > 100
    `;

    const ast = parseSQL(sql);
    const schema = createSchema("trino", [
      createTable("users", ["id", "name", "status"]),
      createTable("orders", ["id", "user_id", "total"]),
    ]);

    const result = getExtendedLineage(ast as Select, schema);

    // JOIN lineage
    const joinLineage = findBySubtype(result.dataset, "JOIN");
    expect(joinLineage.length).toBe(2);

    // FILTER lineage
    const filterLineage = findBySubtype(result.dataset, "FILTER");
    expect(filterLineage.length).toBe(2);
    expect(filterLineage).toContainEqual({
      namespace: "trino",
      name: "users",
      field: "status",
      transformations: [INDIRECT_FILTER],
    });
    expect(filterLineage).toContainEqual({
      namespace: "trino",
      name: "orders",
      field: "total",
      transformations: [INDIRECT_FILTER],
    });
  });
});

describe("getExtendedLineage - JOIN + GROUP BY", () => {
  test("JOIN with GROUP BY aggregation", () => {
    const sql = `
      SELECT 
        u.country,
        COUNT(o.id) as order_count,
        SUM(o.total) as total_revenue
      FROM users u
      JOIN orders o ON u.id = o.user_id
      GROUP BY u.country
    `;

    const ast = parseSQL(sql);
    const schema = createSchema("trino", [
      createTable("users", ["id", "country"]),
      createTable("orders", ["id", "user_id", "total"]),
    ]);

    const result = getExtendedLineage(ast as Select, schema);

    // Field-level lineage with aggregations
    expect(result.fields.order_count?.inputFields[0]?.transformations).toContainEqual(
      expect.objectContaining({ type: "DIRECT", subtype: "AGGREGATION" }),
    );

    // JOIN lineage
    const joinLineage = findBySubtype(result.dataset, "JOIN");
    expect(joinLineage.length).toBe(2);

    // GROUP BY lineage
    const groupByLineage = findBySubtype(result.dataset, "GROUP_BY");
    expect(groupByLineage.length).toBe(1);
    expect(groupByLineage).toContainEqual({
      namespace: "trino",
      name: "users",
      field: "country",
      transformations: [INDIRECT_GROUP_BY],
    });
  });
});

describe("getExtendedLineage - WHERE + GROUP BY + HAVING", () => {
  test("full aggregation query", () => {
    const sql = `
      SELECT 
        department,
        COUNT(*) as employee_count,
        AVG(salary) as avg_salary
      FROM employees
      WHERE status = 'active'
      GROUP BY department
      HAVING COUNT(*) > 5
    `;

    const ast = parseSQL(sql);
    const schema = createSchema("trino", [createTable("employees", ["id", "department", "salary", "status"])]);

    const result = getExtendedLineage(ast as Select, schema);

    // FILTER lineage (from WHERE)
    const filterLineage = findBySubtype(result.dataset, "FILTER");
    expect(filterLineage).toContainEqual({
      namespace: "trino",
      name: "employees",
      field: "status",
      transformations: [INDIRECT_FILTER],
    });

    // GROUP BY lineage
    const groupByLineage = findBySubtype(result.dataset, "GROUP_BY");
    expect(groupByLineage).toContainEqual({
      namespace: "trino",
      name: "employees",
      field: "department",
      transformations: [INDIRECT_GROUP_BY],
    });
  });
});

describe("getExtendedLineage - Full query with all clauses", () => {
  test("comprehensive query with all indirect lineage types", () => {
    const sql = `
      SELECT 
        u.country,
        COUNT(u.id) as user_count,
        SUM(o.total) as total_revenue,
        ROW_NUMBER() OVER (ORDER BY SUM(o.total) DESC) as revenue_rank
      FROM users u
      JOIN orders o ON u.id = o.user_id
      WHERE u.status = 'active' AND o.order_date >= '2024-01-01'
      GROUP BY u.country
      HAVING SUM(o.total) > 1000
      ORDER BY total_revenue DESC
    `;

    const ast = parseSQL(sql);
    const schema = createSchema("trino", [
      createTable("users", ["id", "country", "status"]),
      createTable("orders", ["id", "user_id", "total", "order_date"]),
    ]);

    const result = getExtendedLineage(ast as Select, schema);

    // Field-level lineage
    expect(result.fields.country).toBeDefined();
    expect(result.fields.user_count).toBeDefined();
    expect(result.fields.total_revenue).toBeDefined();

    // Dataset-level lineage
    expect(result.dataset).toBeDefined();
    expect(result.dataset!.length).toBeGreaterThan(0);

    // JOIN lineage
    const joinLineage = findBySubtype(result.dataset, "JOIN");
    expect(joinLineage.length).toBeGreaterThan(0);

    // FILTER lineage (from WHERE)
    const filterLineage = findBySubtype(result.dataset, "FILTER");
    expect(filterLineage.length).toBeGreaterThan(0);

    // GROUP BY lineage
    const groupByLineage = findBySubtype(result.dataset, "GROUP_BY");
    expect(groupByLineage.length).toBeGreaterThan(0);

    // SORT lineage (from ORDER BY)
    // Note: ORDER BY total_revenue references an alias, may not resolve to base column
  });

  test("analytics query with aggregate window functions and multiple joins", () => {
    const sql = `
      SELECT 
        d.name as department_name,
        e.name as employee_name,
        e.salary,
        SUM(e.salary) OVER (PARTITION BY e.department_id ORDER BY e.salary DESC) as running_salary
      FROM employees e
      JOIN departments d ON e.department_id = d.id
      WHERE e.status = 'active'
      ORDER BY d.name, e.salary DESC
    `;

    const ast = parseSQL(sql);
    const schema = createSchema("trino", [
      createTable("employees", ["id", "name", "department_id", "salary", "status"]),
      createTable("departments", ["id", "name"]),
    ]);

    const result = getExtendedLineage(ast as Select, schema);

    // JOIN lineage
    const joinLineage = findBySubtype(result.dataset, "JOIN");
    expect(joinLineage.length).toBe(2);

    // WINDOW lineage from PARTITION BY department_id and ORDER BY salary DESC in OVER clause
    const windowLineage = findBySubtype(result.dataset, "WINDOW");
    expect(windowLineage.length).toBe(2);
    expect(windowLineage).toContainEqual({
      namespace: "trino",
      name: "employees",
      field: "department_id",
      transformations: [INDIRECT_WINDOW],
    });
    expect(windowLineage).toContainEqual({
      namespace: "trino",
      name: "employees",
      field: "salary",
      transformations: [INDIRECT_WINDOW],
    });

    // FILTER lineage
    const filterLineage = findBySubtype(result.dataset, "FILTER");
    expect(filterLineage).toContainEqual({
      namespace: "trino",
      name: "employees",
      field: "status",
      transformations: [INDIRECT_FILTER],
    });

    // SORT lineage
    const sortLineage = findBySubtype(result.dataset, "SORT");
    expect(sortLineage).toContainEqual({
      namespace: "trino",
      name: "departments",
      field: "name",
      transformations: [INDIRECT_SORT],
    });
    expect(sortLineage).toContainEqual({
      namespace: "trino",
      name: "employees",
      field: "salary",
      transformations: [INDIRECT_SORT],
    });

    // Field-level lineage captures the aggregation
    expect(result.fields.running_salary?.inputFields).toContainEqual({
      namespace: "trino",
      name: "employees",
      field: "salary",
      transformations: [DIRECT_AGGREGATION],
    });
  });
});

// =============================================================================
// CTE (WITH clause) TESTS
// =============================================================================

describe("getExtendedLineage - WITH clause (CTEs)", () => {
  test("simple CTE with filter - dataset lineage propagation", () => {
    const sql = `
      WITH active_users AS (
        SELECT id, name, country
        FROM users
        WHERE status = 'active'
      )
      SELECT country, COUNT(*) as count
      FROM active_users
      GROUP BY country
    `;

    const ast = parseSQL(sql);
    const schema = createSchema("trino", [createTable("users", ["id", "name", "country", "status"])]);

    const result = getExtendedLineage(ast as Select, schema);

    // Field-level lineage should trace back to users table
    expect(result.fields.country?.inputFields).toContainEqual({
      namespace: "trino",
      name: "users",
      field: "country",
      transformations: [DIRECT_IDENTITY],
    });

    // Dataset-level lineage from the CTE's WHERE clause should be propagated
    const filterLineage = findBySubtype(result.dataset, "FILTER");
    expect(filterLineage.length).toBe(1);
    expect(filterLineage).toContainEqual({
      namespace: "trino",
      name: "users",
      field: "status",
      transformations: [INDIRECT_FILTER],
    });

    // GROUP BY from outer query should also be captured (but references the CTE, not direct table)
    const groupByLineage = findBySubtype(result.dataset, "GROUP_BY");
    // country GROUP BY references active_users.country which resolves to users.country
    expect(groupByLineage.length).toBe(0); // GROUP BY references CTE alias, not resolved to base table
  });

  test("multiple CTEs", () => {
    const sql = `
      WITH 
      active_users AS (
        SELECT id, name, country FROM users WHERE status = 'active'
      ),
      user_orders AS (
        SELECT user_id, SUM(total) as total_spent FROM orders GROUP BY user_id
      )
      SELECT 
        au.name,
        au.country,
        uo.total_spent
      FROM active_users au
      JOIN user_orders uo ON au.id = uo.user_id
    `;

    const ast = parseSQL(sql);
    const schema = createSchema("trino", [
      createTable("users", ["id", "name", "country", "status"]),
      createTable("orders", ["id", "user_id", "total"]),
    ]);

    const result = getExtendedLineage(ast as Select, schema);

    // ========== Field-level lineage ==========
    
    // name traces back to users.name with IDENTITY
    expect(result.fields.name).toBeDefined();
    expect(result.fields.name?.inputFields.length).toBe(1);
    expect(result.fields.name?.inputFields).toContainEqual({
      namespace: "trino",
      name: "users",
      field: "name",
      transformations: [DIRECT_IDENTITY],
    });

    // country traces back to users.country with IDENTITY
    expect(result.fields.country).toBeDefined();
    expect(result.fields.country?.inputFields.length).toBe(1);
    expect(result.fields.country?.inputFields).toContainEqual({
      namespace: "trino",
      name: "users",
      field: "country",
      transformations: [DIRECT_IDENTITY],
    });

    // total_spent traces back to orders.total with AGGREGATION (through SUM in CTE)
    expect(result.fields.total_spent).toBeDefined();
    expect(result.fields.total_spent?.inputFields.length).toBe(1);
    expect(result.fields.total_spent?.inputFields).toContainEqual({
      namespace: "trino",
      name: "orders",
      field: "total",
      transformations: [DIRECT_AGGREGATION],
    });

    // ========== Dataset-level lineage ==========
    // Dataset lineage from CTEs is now propagated to outer query
    
    // FILTER from active_users CTE (WHERE status = 'active')
    const filterLineage = findBySubtype(result.dataset, "FILTER");
    expect(filterLineage.length).toBe(1);
    expect(filterLineage).toContainEqual({
      namespace: "trino",
      name: "users",
      field: "status",
      transformations: [INDIRECT_FILTER],
    });

    // GROUP BY from user_orders CTE (GROUP BY user_id)
    const groupByLineage = findBySubtype(result.dataset, "GROUP_BY");
    expect(groupByLineage.length).toBe(1);
    expect(groupByLineage).toContainEqual({
      namespace: "trino",
      name: "orders",
      field: "user_id",
      transformations: [INDIRECT_GROUP_BY],
    });

    // Verify we have the correct number of output fields
    expect(Object.keys(result.fields).length).toBe(3);
  });

  test("nested CTEs with complex transformations", () => {
    const sql = `
      WITH 
      base_data AS (
        SELECT 
          product_id,
          store_id,
          quantity * price as revenue
        FROM sales
        WHERE sale_date >= '2024-01-01'
      ),
      store_summary AS (
        SELECT 
          store_id,
          SUM(revenue) as total_revenue
        FROM base_data
        GROUP BY store_id
      )
      SELECT 
        s.name as store_name,
        ss.total_revenue
      FROM store_summary ss
      JOIN stores s ON ss.store_id = s.id
      ORDER BY ss.total_revenue DESC
    `;

    const ast = parseSQL(sql);
    const schema = createSchema("trino", [
      createTable("sales", ["id", "product_id", "store_id", "quantity", "price", "sale_date"]),
      createTable("stores", ["id", "name"]),
    ]);

    const result = getExtendedLineage(ast as Select, schema);

    // ========== Field-level lineage ==========
    
    // store_name should trace back to stores.name
    expect(result.fields.store_name).toBeDefined();
    expect(result.fields.store_name?.inputFields).toContainEqual({
      namespace: "trino",
      name: "stores",
      field: "name",
      transformations: [DIRECT_IDENTITY],
    });

    // total_revenue should trace back through CTEs to quantity and price with AGGREGATION
    expect(result.fields.total_revenue).toBeDefined();
    expect(result.fields.total_revenue?.inputFields.length).toBe(2);
    expect(result.fields.total_revenue?.inputFields).toContainEqual({
      namespace: "trino",
      name: "sales",
      field: "quantity",
      transformations: [DIRECT_AGGREGATION],
    });
    expect(result.fields.total_revenue?.inputFields).toContainEqual({
      namespace: "trino",
      name: "sales",
      field: "price",
      transformations: [DIRECT_AGGREGATION],
    });

    // ========== Dataset-level lineage ==========
    
    // JOIN lineage - should capture the join between store_summary and stores
    const joinLineage = findBySubtype(result.dataset, "JOIN");
    expect(joinLineage.length).toBe(1);
    expect(joinLineage).toContainEqual({
      namespace: "trino",
      name: "stores",
      field: "id",
      transformations: [INDIRECT_JOIN],
    });

    // FILTER lineage - propagated from base_data CTE (WHERE sale_date >= '2024-01-01')
    const filterLineage = findBySubtype(result.dataset, "FILTER");
    expect(filterLineage.length).toBe(1);
    expect(filterLineage).toContainEqual({
      namespace: "trino",
      name: "sales",
      field: "sale_date",
      transformations: [INDIRECT_FILTER],
    });

    // Note: GROUP BY in store_summary (GROUP BY store_id) references base_data.store_id
    // which is a CTE column, not a direct table column. Dataset lineage extraction 
    // for GROUP BY/ORDER BY only resolves to direct table columns, not CTE columns.
    // This is a known limitation - CTE-to-CTE indirect lineage is not resolved.
    const groupByLineage = findBySubtype(result.dataset, "GROUP_BY");
    expect(groupByLineage.length).toBe(0);
  });
});

// =============================================================================
// SUBQUERY TESTS
// =============================================================================

describe("getExtendedLineage - Subqueries", () => {
  test("subquery in FROM clause", () => {
    const sql = `
      SELECT 
        sub.country,
        sub.user_count
      FROM (
        SELECT country, COUNT(*) as user_count
        FROM users
        WHERE status = 'active'
        GROUP BY country
      ) sub
      ORDER BY sub.user_count DESC
    `;

    const ast = parseSQL(sql);
    const schema = createSchema("trino", [createTable("users", ["id", "country", "status"])]);

    const result = getExtendedLineage(ast as Select, schema);

    expect(result.fields.country?.inputFields).toContainEqual({
      namespace: "trino",
      name: "users",
      field: "country",
      transformations: [DIRECT_IDENTITY],
    });
  });
});

// =============================================================================
// EDGE CASES AND SPECIAL SCENARIOS
// =============================================================================

describe("getExtendedLineage - Edge cases", () => {
  test("same column used in multiple contexts", () => {
    const sql = `
      SELECT 
        status,
        COUNT(*) as count
      FROM users
      WHERE status != 'deleted'
      GROUP BY status
      ORDER BY status
    `;

    const ast = parseSQL(sql);
    const schema = createSchema("trino", [createTable("users", ["id", "status"])]);

    const result = getExtendedLineage(ast as Select, schema);

    // status appears in:
    // 1. SELECT (DIRECT/IDENTITY)
    // 2. WHERE (INDIRECT/FILTER)
    // 3. GROUP BY (INDIRECT/GROUP_BY)
    // 4. ORDER BY (INDIRECT/SORT)

    expect(result.fields.status?.inputFields).toContainEqual({
      namespace: "trino",
      name: "users",
      field: "status",
      transformations: [DIRECT_IDENTITY],
    });

    const filterLineage = findFieldBySubtype(result.dataset, "status", "FILTER");
    expect(filterLineage).toBeDefined();

    const groupByLineage = findFieldBySubtype(result.dataset, "status", "GROUP_BY");
    expect(groupByLineage).toBeDefined();

    const sortLineage = findFieldBySubtype(result.dataset, "status", "SORT");
    expect(sortLineage).toBeDefined();
  });

  test("column from multiple tables with same name", () => {
    const sql = `
      SELECT u.name as user_name, p.name as product_name
      FROM users u
      JOIN products p ON u.favorite_product_id = p.id
      WHERE u.name LIKE 'A%' AND p.name LIKE 'Widget%'
    `;

    const ast = parseSQL(sql);
    const schema = createSchema("trino", [
      createTable("users", ["id", "name", "favorite_product_id"]),
      createTable("products", ["id", "name"]),
    ]);

    const result = getExtendedLineage(ast as Select, schema);

    // Field-level lineage should distinguish the two name columns
    expect(result.fields.user_name?.inputFields).toContainEqual({
      namespace: "trino",
      name: "users",
      field: "name",
      transformations: [DIRECT_IDENTITY],
    });
    expect(result.fields.product_name?.inputFields).toContainEqual({
      namespace: "trino",
      name: "products",
      field: "name",
      transformations: [DIRECT_IDENTITY],
    });

    // FILTER lineage should have both name columns
    const filterLineage = findBySubtype(result.dataset, "FILTER");
    expect(filterLineage).toContainEqual({
      namespace: "trino",
      name: "users",
      field: "name",
      transformations: [INDIRECT_FILTER],
    });
    expect(filterLineage).toContainEqual({
      namespace: "trino",
      name: "products",
      field: "name",
      transformations: [INDIRECT_FILTER],
    });
  });

  test("deduplication of dataset lineage", () => {
    const sql = `
      SELECT id, name
      FROM users
      WHERE status = 'active' AND status != 'banned'
    `;

    const ast = parseSQL(sql);
    const schema = createSchema("trino", [createTable("users", ["id", "name", "status"])]);

    const result = getExtendedLineage(ast as Select, schema);

    // Even though status appears twice in WHERE, it should be deduplicated
    const filterLineage = findBySubtype(result.dataset, "FILTER");
    const statusFilters = filterLineage.filter((f) => f.field === "status");
    expect(statusFilters.length).toBe(1);
  });

  test("empty dataset lineage when no indirect clauses", () => {
    const sql = `SELECT id, UPPER(name) as upper_name FROM users`;

    const ast = parseSQL(sql);
    const schema = createSchema("trino", [createTable("users", ["id", "name"])]);

    const result = getExtendedLineage(ast as Select, schema);

    expect(result.fields.id).toBeDefined();
    expect(result.fields.upper_name).toBeDefined();
    expect(result.dataset).toEqual([]);
  });

  test("transformation functions with masking", () => {
    const sql = `
      SELECT 
        MD5(email) as email_hash,
        SHA256(ssn) as ssn_hash,
        MASK(phone) as masked_phone
      FROM users
    `;

    const ast = parseSQL(sql);
    const schema = createSchema("trino", [createTable("users", ["id", "email", "ssn", "phone"])]);

    const result = getExtendedLineage(ast as Select, schema);

    // All three should have masking: true in their transformations
    expect(result.fields.email_hash?.inputFields[0]?.transformations?.[0]?.masking).toBe(true);
    expect(result.fields.ssn_hash?.inputFields[0]?.transformations?.[0]?.masking).toBe(true);
    expect(result.fields.masked_phone?.inputFields[0]?.transformations?.[0]?.masking).toBe(true);
  });

  test("COUNT aggregation has masking flag", () => {
    const sql = `
      SELECT country, COUNT(id) as user_count
      FROM users
      GROUP BY country
    `;

    const ast = parseSQL(sql);
    const schema = createSchema("trino", [createTable("users", ["id", "country"])]);

    const result = getExtendedLineage(ast as Select, schema);

    // COUNT should have masking: true
    expect(result.fields.user_count?.inputFields[0]?.transformations).toContainEqual({
      type: "DIRECT",
      subtype: "AGGREGATION",
      masking: true,
    });
  });
});

// =============================================================================
// REAL-WORLD COMPLEX QUERIES
// =============================================================================

describe("getExtendedLineage - Real-world complex queries", () => {
  test("e-commerce analytics query", () => {
    const sql = `
      SELECT 
        c.name as category_name,
        p.name as product_name,
        SUM(oi.quantity) as total_quantity,
        SUM(oi.quantity * oi.unit_price) as total_revenue,
        AVG(oi.unit_price) as avg_price
      FROM categories c
      JOIN products p ON c.id = p.category_id
      JOIN order_items oi ON p.id = oi.product_id
      JOIN orders o ON oi.order_id = o.id
      WHERE o.status = 'completed' AND o.order_date >= '2024-01-01'
      GROUP BY c.id, c.name, p.id, p.name
      HAVING SUM(oi.quantity) > 10
      ORDER BY c.name, total_revenue DESC
    `;

    const ast = parseSQL(sql);
    const schema = createSchema("trino", [
      createTable("categories", ["id", "name"]),
      createTable("products", ["id", "name", "category_id"]),
      createTable("order_items", ["id", "order_id", "product_id", "quantity", "unit_price"]),
      createTable("orders", ["id", "status", "order_date"]),
    ]);

    const result = getExtendedLineage(ast as Select, schema);

    // ========== Field-level lineage ==========
    
    // category_name traces to categories.name
    expect(result.fields.category_name).toBeDefined();
    expect(result.fields.category_name?.inputFields).toContainEqual({
      namespace: "trino",
      name: "categories",
      field: "name",
      transformations: [DIRECT_IDENTITY],
    });

    // product_name traces to products.name
    expect(result.fields.product_name).toBeDefined();
    expect(result.fields.product_name?.inputFields).toContainEqual({
      namespace: "trino",
      name: "products",
      field: "name",
      transformations: [DIRECT_IDENTITY],
    });

    // total_quantity traces to order_items.quantity with AGGREGATION
    expect(result.fields.total_quantity).toBeDefined();
    expect(result.fields.total_quantity?.inputFields).toContainEqual({
      namespace: "trino",
      name: "order_items",
      field: "quantity",
      transformations: [DIRECT_AGGREGATION],
    });

    // total_revenue traces to both quantity and unit_price with AGGREGATION
    expect(result.fields.total_revenue).toBeDefined();
    expect(result.fields.total_revenue?.inputFields.length).toBe(2);
    expect(result.fields.total_revenue?.inputFields).toContainEqual({
      namespace: "trino",
      name: "order_items",
      field: "quantity",
      transformations: [DIRECT_AGGREGATION],
    });
    expect(result.fields.total_revenue?.inputFields).toContainEqual({
      namespace: "trino",
      name: "order_items",
      field: "unit_price",
      transformations: [DIRECT_AGGREGATION],
    });

    // avg_price traces to order_items.unit_price with AGGREGATION
    expect(result.fields.avg_price).toBeDefined();
    expect(result.fields.avg_price?.inputFields).toContainEqual({
      namespace: "trino",
      name: "order_items",
      field: "unit_price",
      transformations: [DIRECT_AGGREGATION],
    });

    // ========== Dataset-level lineage ==========
    
    // JOIN lineage - 3 joins with 2 columns each = 6 join columns
    const joinLineage = findBySubtype(result.dataset, "JOIN");
    expect(joinLineage.length).toBe(6);
    // First join: c.id = p.category_id
    expect(joinLineage).toContainEqual({
      namespace: "trino",
      name: "categories",
      field: "id",
      transformations: [INDIRECT_JOIN],
    });
    expect(joinLineage).toContainEqual({
      namespace: "trino",
      name: "products",
      field: "category_id",
      transformations: [INDIRECT_JOIN],
    });
    // Second join: p.id = oi.product_id
    expect(joinLineage).toContainEqual({
      namespace: "trino",
      name: "products",
      field: "id",
      transformations: [INDIRECT_JOIN],
    });
    expect(joinLineage).toContainEqual({
      namespace: "trino",
      name: "order_items",
      field: "product_id",
      transformations: [INDIRECT_JOIN],
    });
    // Third join: oi.order_id = o.id
    expect(joinLineage).toContainEqual({
      namespace: "trino",
      name: "order_items",
      field: "order_id",
      transformations: [INDIRECT_JOIN],
    });
    expect(joinLineage).toContainEqual({
      namespace: "trino",
      name: "orders",
      field: "id",
      transformations: [INDIRECT_JOIN],
    });

    // FILTER lineage - status and order_date from WHERE clause
    const filterLineage = findBySubtype(result.dataset, "FILTER");
    expect(filterLineage.length).toBeGreaterThanOrEqual(2);
    expect(filterLineage).toContainEqual({
      namespace: "trino",
      name: "orders",
      field: "status",
      transformations: [INDIRECT_FILTER],
    });
    expect(filterLineage).toContainEqual({
      namespace: "trino",
      name: "orders",
      field: "order_date",
      transformations: [INDIRECT_FILTER],
    });
    // HAVING also contributes to filter lineage
    expect(filterLineage).toContainEqual({
      namespace: "trino",
      name: "order_items",
      field: "quantity",
      transformations: [INDIRECT_FILTER],
    });

    // GROUP BY lineage - c.id, c.name, p.id, p.name
    const groupByLineage = findBySubtype(result.dataset, "GROUP_BY");
    expect(groupByLineage.length).toBe(4);
    expect(groupByLineage).toContainEqual({
      namespace: "trino",
      name: "categories",
      field: "id",
      transformations: [INDIRECT_GROUP_BY],
    });
    expect(groupByLineage).toContainEqual({
      namespace: "trino",
      name: "categories",
      field: "name",
      transformations: [INDIRECT_GROUP_BY],
    });
    expect(groupByLineage).toContainEqual({
      namespace: "trino",
      name: "products",
      field: "id",
      transformations: [INDIRECT_GROUP_BY],
    });
    expect(groupByLineage).toContainEqual({
      namespace: "trino",
      name: "products",
      field: "name",
      transformations: [INDIRECT_GROUP_BY],
    });

    // SORT lineage - c.name (total_revenue is alias, may not resolve)
    const sortLineage = findBySubtype(result.dataset, "SORT");
    expect(sortLineage).toContainEqual({
      namespace: "trino",
      name: "categories",
      field: "name",
      transformations: [INDIRECT_SORT],
    });
  });

  test("HR analytics query with employee hierarchy", () => {
    const sql = `
      WITH department_stats AS (
        SELECT 
          department_id,
          COUNT(*) as employee_count,
          AVG(salary) as avg_salary,
          SUM(salary) as total_salary
        FROM employees
        WHERE status = 'active'
        GROUP BY department_id
      )
      SELECT 
        d.name as department_name,
        ds.employee_count,
        ds.avg_salary,
        ds.total_salary,
        CASE 
          WHEN ds.avg_salary > 100000 THEN 'High'
          WHEN ds.avg_salary > 50000 THEN 'Medium'
          ELSE 'Low'
        END as salary_tier,
        RANK() OVER (ORDER BY ds.total_salary DESC) as budget_rank
      FROM department_stats ds
      JOIN departments d ON ds.department_id = d.id
      WHERE ds.employee_count >= 5
      ORDER BY budget_rank
    `;

    const ast = parseSQL(sql);
    const schema = createSchema("trino", [
      createTable("employees", ["id", "department_id", "salary", "status"]),
      createTable("departments", ["id", "name"]),
    ]);

    const result = getExtendedLineage(ast as Select, schema);

    // ========== Field-level lineage ==========
    
    // department_name traces to departments.name
    expect(result.fields.department_name).toBeDefined();
    expect(result.fields.department_name?.inputFields).toContainEqual({
      namespace: "trino",
      name: "departments",
      field: "name",
      transformations: [DIRECT_IDENTITY],
    });

    // employee_count comes from COUNT(*) in CTE - no specific field traced
    expect(result.fields.employee_count).toBeDefined();
    // COUNT(*) doesn't reference a specific column, so inputFields may be empty

    // avg_salary traces to employees.salary with AGGREGATION
    expect(result.fields.avg_salary).toBeDefined();
    expect(result.fields.avg_salary?.inputFields).toContainEqual({
      namespace: "trino",
      name: "employees",
      field: "salary",
      transformations: [DIRECT_AGGREGATION],
    });

    // total_salary traces to employees.salary with AGGREGATION
    expect(result.fields.total_salary).toBeDefined();
    expect(result.fields.total_salary?.inputFields).toContainEqual({
      namespace: "trino",
      name: "employees",
      field: "salary",
      transformations: [DIRECT_AGGREGATION],
    });

    // salary_tier uses CASE with avg_salary in conditions - traces back to salary
    expect(result.fields.salary_tier).toBeDefined();
    expect(result.fields.salary_tier?.inputFields.length).toBeGreaterThan(0);
    // The salary_tier CASE statement references avg_salary which traces to employees.salary
    const salaryTierFields = result.fields.salary_tier?.inputFields.map((f) => f.field);
    expect(salaryTierFields).toContain("salary");
    // Should have CONDITION subtype for the WHEN clauses
    const hasConditionTransformation = result.fields.salary_tier?.inputFields.some(
      (f) => f.transformations?.some((t) => t.subtype === "CONDITION" || t.subtype === "AGGREGATION"),
    );
    expect(hasConditionTransformation).toBe(true);

    // budget_rank from RANK() OVER (ORDER BY ds.total_salary DESC) - now tracks columns from OVER clause
    expect(result.fields.budget_rank).toBeDefined();
    // RANK() has no arguments, but it should capture total_salary from ORDER BY in OVER clause
    // total_salary traces back through CTE to employees.salary
    expect(result.fields.budget_rank?.inputFields.length).toBeGreaterThan(0);
    const budgetRankFields = result.fields.budget_rank?.inputFields.map((f) => f.field);
    expect(budgetRankFields).toContain("salary");

    // ========== Dataset-level lineage ==========
    
    // JOIN lineage - ds.department_id = d.id
    const joinLineage = findBySubtype(result.dataset, "JOIN");
    expect(joinLineage.length).toBeGreaterThanOrEqual(1);
    expect(joinLineage).toContainEqual({
      namespace: "trino",
      name: "departments",
      field: "id",
      transformations: [INDIRECT_JOIN],
    });

    // Verify total output field count
    expect(Object.keys(result.fields).length).toBe(6);
  });

  test("time-series analysis query", () => {
    const sql = `
      SELECT 
        DATE_TRUNC('month', event_date) as month,
        event_type,
        COUNT(*) as event_count,
        COUNT(DISTINCT user_id) as unique_users
      FROM events
      WHERE event_date >= '2024-01-01'
        AND event_type IN ('login', 'purchase', 'view')
      GROUP BY DATE_TRUNC('month', event_date), event_type
      ORDER BY month, event_type
    `;

    const ast = parseSQL(sql);
    const schema = createSchema("trino", [createTable("events", ["id", "event_date", "event_type", "user_id"])]);

    const result = getExtendedLineage(ast as Select, schema);

    // ========== Field-level lineage ==========
    
    // month traces to event_date with TRANSFORMATION (DATE_TRUNC)
    expect(result.fields.month).toBeDefined();
    expect(result.fields.month?.inputFields.length).toBe(1);
    expect(result.fields.month?.inputFields[0]?.field).toBe("event_date");
    expect(result.fields.month?.inputFields[0]?.transformations?.[0]?.subtype).toBe("TRANSFORMATION");

    // event_type is direct IDENTITY
    expect(result.fields.event_type).toBeDefined();
    expect(result.fields.event_type?.inputFields).toContainEqual({
      namespace: "trino",
      name: "events",
      field: "event_type",
      transformations: [DIRECT_IDENTITY],
    });

    // event_count from COUNT(*) - no specific field
    expect(result.fields.event_count).toBeDefined();

    // unique_users from COUNT(DISTINCT user_id) - traces to user_id with AGGREGATION + masking
    expect(result.fields.unique_users).toBeDefined();
    expect(result.fields.unique_users?.inputFields.length).toBe(1);
    expect(result.fields.unique_users?.inputFields[0]?.field).toBe("user_id");
    expect(result.fields.unique_users?.inputFields[0]?.transformations?.[0]?.subtype).toBe("AGGREGATION");
    expect(result.fields.unique_users?.inputFields[0]?.transformations?.[0]?.masking).toBe(true);

    // Verify total output field count
    expect(Object.keys(result.fields).length).toBe(4);

    // ========== Dataset-level lineage ==========
    
    // FILTER lineage - event_date and event_type from WHERE
    const filterLineage = findBySubtype(result.dataset, "FILTER");
    expect(filterLineage.length).toBe(2);
    expect(filterLineage).toContainEqual({
      namespace: "trino",
      name: "events",
      field: "event_date",
      transformations: [INDIRECT_FILTER],
    });
    expect(filterLineage).toContainEqual({
      namespace: "trino",
      name: "events",
      field: "event_type",
      transformations: [INDIRECT_FILTER],
    });

    // GROUP BY lineage - DATE_TRUNC('month', event_date) and event_type
    const groupByLineage = findBySubtype(result.dataset, "GROUP_BY");
    expect(groupByLineage.length).toBe(2);
    expect(groupByLineage).toContainEqual({
      namespace: "trino",
      name: "events",
      field: "event_date",
      transformations: [INDIRECT_GROUP_BY],
    });
    expect(groupByLineage).toContainEqual({
      namespace: "trino",
      name: "events",
      field: "event_type",
      transformations: [INDIRECT_GROUP_BY],
    });

    // SORT lineage - month and event_type
    // Note: month is an alias that may not resolve to base column
    const sortLineage = findBySubtype(result.dataset, "SORT");
    expect(sortLineage).toContainEqual({
      namespace: "trino",
      name: "events",
      field: "event_type",
      transformations: [INDIRECT_SORT],
    });
  });

  test("multi-level aggregation query", () => {
    const sql = `
      WITH daily_sales AS (
        SELECT 
          store_id,
          DATE(sale_timestamp) as sale_date,
          SUM(amount) as daily_total
        FROM sales
        WHERE sale_timestamp >= '2024-01-01'
        GROUP BY store_id, DATE(sale_timestamp)
      ),
      weekly_sales AS (
        SELECT 
          store_id,
          DATE_TRUNC('week', sale_date) as week_start,
          SUM(daily_total) as weekly_total,
          AVG(daily_total) as daily_avg
        FROM daily_sales
        GROUP BY store_id, DATE_TRUNC('week', sale_date)
      )
      SELECT 
        s.name as store_name,
        s.region,
        ws.week_start,
        ws.weekly_total,
        ws.daily_avg
      FROM weekly_sales ws
      JOIN stores s ON ws.store_id = s.id
      ORDER BY s.region, ws.week_start
    `;

    const ast = parseSQL(sql);
    const schema = createSchema("trino", [
      createTable("sales", ["id", "store_id", "sale_timestamp", "amount"]),
      createTable("stores", ["id", "name", "region"]),
    ]);

    const result = getExtendedLineage(ast as Select, schema);

    // ========== Field-level lineage ==========
    
    // store_name traces to stores.name
    expect(result.fields.store_name).toBeDefined();
    expect(result.fields.store_name?.inputFields).toContainEqual({
      namespace: "trino",
      name: "stores",
      field: "name",
      transformations: [DIRECT_IDENTITY],
    });

    // region traces to stores.region
    expect(result.fields.region).toBeDefined();
    expect(result.fields.region?.inputFields).toContainEqual({
      namespace: "trino",
      name: "stores",
      field: "region",
      transformations: [DIRECT_IDENTITY],
    });

    // week_start traces through CTEs to sale_timestamp (via DATE and DATE_TRUNC transformations)
    expect(result.fields.week_start).toBeDefined();
    expect(result.fields.week_start?.inputFields.length).toBe(1);
    expect(result.fields.week_start?.inputFields[0]?.field).toBe("sale_timestamp");
    expect(result.fields.week_start?.inputFields[0]?.name).toBe("sales");
    // Should have TRANSFORMATION due to DATE_TRUNC/DATE functions
    expect(result.fields.week_start?.inputFields[0]?.transformations?.[0]?.type).toBe("DIRECT");

    // weekly_total traces through CTEs: SUM(SUM(amount)) -> amount with AGGREGATION
    expect(result.fields.weekly_total).toBeDefined();
    expect(result.fields.weekly_total?.inputFields.length).toBe(1);
    expect(result.fields.weekly_total?.inputFields).toContainEqual({
      namespace: "trino",
      name: "sales",
      field: "amount",
      transformations: [DIRECT_AGGREGATION],
    });

    // daily_avg traces through CTEs: AVG(SUM(amount)) -> amount with AGGREGATION
    expect(result.fields.daily_avg).toBeDefined();
    expect(result.fields.daily_avg?.inputFields.length).toBe(1);
    expect(result.fields.daily_avg?.inputFields).toContainEqual({
      namespace: "trino",
      name: "sales",
      field: "amount",
      transformations: [DIRECT_AGGREGATION],
    });

    // Verify total output field count
    expect(Object.keys(result.fields).length).toBe(5);

    // ========== Dataset-level lineage ==========
    
    // JOIN lineage - ws.store_id = s.id
    // Note: store_id from CTE doesn't resolve, but stores.id does
    const joinLineage = findBySubtype(result.dataset, "JOIN");
    expect(joinLineage.length).toBeGreaterThanOrEqual(1);
    expect(joinLineage).toContainEqual({
      namespace: "trino",
      name: "stores",
      field: "id",
      transformations: [INDIRECT_JOIN],
    });

    // SORT lineage - s.region and ws.week_start
    // s.region should resolve to stores.region
    const sortLineage = findBySubtype(result.dataset, "SORT");
    expect(sortLineage.length).toBeGreaterThanOrEqual(1);
    expect(sortLineage).toContainEqual({
      namespace: "trino",
      name: "stores",
      field: "region",
      transformations: [INDIRECT_SORT],
    });
  });
});

// =============================================================================
// TRANSFORMATION TYPE VERIFICATION
// =============================================================================

describe("getExtendedLineage - Transformation type verification", () => {
  test("verifies all transformation types are correct", () => {
    const sql = `
      SELECT 
        u.country,
        COUNT(u.id) as user_count,
        ROW_NUMBER() OVER (ORDER BY COUNT(u.id) DESC) as rank
      FROM users u
      JOIN orders o ON u.id = o.user_id
      WHERE u.status = 'active'
      GROUP BY u.country
      ORDER BY u.country
    `;

    const ast = parseSQL(sql);
    const schema = createSchema("trino", [
      createTable("users", ["id", "country", "status"]),
      createTable("orders", ["id", "user_id"]),
    ]);

    const result = getExtendedLineage(ast as Select, schema);

    // Verify JOIN transformation structure
    const joinLineage = findBySubtype(result.dataset, "JOIN");
    joinLineage.forEach((field) => {
      expect(field.transformations?.[0]).toEqual(INDIRECT_JOIN);
    });

    // Verify FILTER transformation structure
    const filterLineage = findBySubtype(result.dataset, "FILTER");
    filterLineage.forEach((field) => {
      expect(field.transformations?.[0]).toEqual(INDIRECT_FILTER);
    });

    // Verify GROUP_BY transformation structure
    const groupByLineage = findBySubtype(result.dataset, "GROUP_BY");
    groupByLineage.forEach((field) => {
      expect(field.transformations?.[0]).toEqual(INDIRECT_GROUP_BY);
    });

    // Verify SORT transformation structure
    const sortLineage = findBySubtype(result.dataset, "SORT");
    sortLineage.forEach((field) => {
      expect(field.transformations?.[0]).toEqual(INDIRECT_SORT);
    });
  });

  test("field-level transformations for direct lineage", () => {
    const sql = `
      SELECT 
        id,
        name,
        UPPER(email) as upper_email,
        age + 1 as next_age,
        COUNT(status) as status_count,
        SUM(salary) as total_salary
      FROM employees
      GROUP BY id, name, email, age
    `;

    const ast = parseSQL(sql);
    const schema = createSchema("trino", [
      createTable("employees", ["id", "name", "email", "age", "status", "salary"]),
    ]);

    const result = getExtendedLineage(ast as Select, schema);

    // IDENTITY transformations
    expect(result.fields.id?.inputFields[0]?.transformations).toContainEqual(DIRECT_IDENTITY);
    expect(result.fields.name?.inputFields[0]?.transformations).toContainEqual(DIRECT_IDENTITY);

    // TRANSFORMATION (function)
    expect(result.fields.upper_email?.inputFields[0]?.transformations).toContainEqual(DIRECT_TRANSFORMATION);

    // TRANSFORMATION (arithmetic)
    expect(result.fields.next_age?.inputFields[0]?.transformations).toContainEqual(DIRECT_TRANSFORMATION);

    // AGGREGATION (with masking for COUNT)
    expect(result.fields.status_count?.inputFields[0]?.transformations).toContainEqual({
      ...DIRECT_AGGREGATION,
      masking: true,
    });

    // AGGREGATION (without masking for SUM)
    expect(result.fields.total_salary?.inputFields[0]?.transformations).toContainEqual(DIRECT_AGGREGATION);
  });
});

// Helper to parse SQL for PostgreSQL (which supports INTERSECT and EXCEPT)
function parseSQLPostgres(sql: string): AST {
  const result = parser.astify(sql, { database: "postgresql" });
  const ast = Array.isArray(result) ? result[0] : result;

  if (!ast) {
    throw new Error("Failed to parse SQL");
  }

  return ast;
}

describe("getExtendedLineage - Set Operations (UNION, INTERSECT, EXCEPT)", () => {
  test("UNION with WHERE clauses captures all dataset lineage", () => {
    const sql = `
      SELECT id, name FROM users WHERE status = 'active'
      UNION
      SELECT id, name FROM customers WHERE verified = true
    `;
    const ast = parseSQLPostgres(sql);
    const schema = createSchema("postgres", [
      createTable("users", ["id", "name", "status"]),
      createTable("customers", ["id", "name", "verified"]),
    ]);

    const result = getExtendedLineage(ast as Select, schema);

    // Field lineage should combine both sources
    expect(result.fields.id?.inputFields).toHaveLength(2);
    expect(result.fields.name?.inputFields).toHaveLength(2);

    // Dataset lineage should include filters from both queries
    const filterLineage = findBySubtype(result.dataset, "FILTER");
    expect(filterLineage).toHaveLength(2);
    expect(filterLineage).toContainEqual({
      namespace: "postgres",
      name: "users",
      field: "status",
      transformations: [INDIRECT_FILTER],
    });
    expect(filterLineage).toContainEqual({
      namespace: "postgres",
      name: "customers",
      field: "verified",
      transformations: [INDIRECT_FILTER],
    });
  });

  test("INTERSECT with GROUP BY captures all dataset lineage", () => {
    const sql = `
      SELECT department_id FROM employees GROUP BY department_id
      INTERSECT
      SELECT department_id FROM managers GROUP BY department_id
    `;
    const ast = parseSQLPostgres(sql);
    const schema = createSchema("postgres", [
      createTable("employees", ["id", "department_id"]),
      createTable("managers", ["id", "department_id"]),
    ]);

    const result = getExtendedLineage(ast as Select, schema);

    // Field lineage combines both sources
    expect(result.fields.department_id?.inputFields).toHaveLength(2);

    // Dataset lineage should include GROUP BY from both queries
    const groupByLineage = findBySubtype(result.dataset, "GROUP_BY");
    expect(groupByLineage).toHaveLength(2);
    expect(groupByLineage).toContainEqual({
      namespace: "postgres",
      name: "employees",
      field: "department_id",
      transformations: [INDIRECT_GROUP_BY],
    });
    expect(groupByLineage).toContainEqual({
      namespace: "postgres",
      name: "managers",
      field: "department_id",
      transformations: [INDIRECT_GROUP_BY],
    });
  });

  test("EXCEPT with ORDER BY captures all dataset lineage", () => {
    const sql = `
      SELECT id FROM users ORDER BY created_at
      EXCEPT
      SELECT id FROM banned_users ORDER BY banned_at
    `;
    const ast = parseSQLPostgres(sql);
    const schema = createSchema("postgres", [
      createTable("users", ["id", "created_at"]),
      createTable("banned_users", ["id", "banned_at"]),
    ]);

    const result = getExtendedLineage(ast as Select, schema);

    // Dataset lineage should include ORDER BY from both queries
    const sortLineage = findBySubtype(result.dataset, "SORT");
    expect(sortLineage).toHaveLength(2);
    expect(sortLineage).toContainEqual({
      namespace: "postgres",
      name: "users",
      field: "created_at",
      transformations: [INDIRECT_SORT],
    });
    expect(sortLineage).toContainEqual({
      namespace: "postgres",
      name: "banned_users",
      field: "banned_at",
      transformations: [INDIRECT_SORT],
    });
  });

  test("chained UNION captures dataset lineage from all parts", () => {
    const sql = `
      SELECT id FROM users WHERE region = 'US'
      UNION
      SELECT id FROM customers WHERE region = 'EU'
      UNION
      SELECT id FROM vendors WHERE region = 'APAC'
    `;
    const ast = parseSQLPostgres(sql);
    const schema = createSchema("postgres", [
      createTable("users", ["id", "region"]),
      createTable("customers", ["id", "region"]),
      createTable("vendors", ["id", "region"]),
    ]);

    const result = getExtendedLineage(ast as Select, schema);

    // Dataset lineage should include filters from all three queries
    const filterLineage = findBySubtype(result.dataset, "FILTER");
    expect(filterLineage).toHaveLength(3);
    expect(filterLineage).toContainEqual({
      namespace: "postgres",
      name: "users",
      field: "region",
      transformations: [INDIRECT_FILTER],
    });
    expect(filterLineage).toContainEqual({
      namespace: "postgres",
      name: "customers",
      field: "region",
      transformations: [INDIRECT_FILTER],
    });
    expect(filterLineage).toContainEqual({
      namespace: "postgres",
      name: "vendors",
      field: "region",
      transformations: [INDIRECT_FILTER],
    });
  });

  test("UNION with JOINs captures dataset lineage from both parts", () => {
    const sql = `
      SELECT u.id, u.name 
      FROM users u 
      JOIN orders o ON u.id = o.user_id
      UNION
      SELECT c.id, c.name 
      FROM customers c 
      JOIN purchases p ON c.id = p.customer_id
    `;
    const ast = parseSQLPostgres(sql);
    const schema = createSchema("postgres", [
      createTable("users", ["id", "name"]),
      createTable("orders", ["id", "user_id"]),
      createTable("customers", ["id", "name"]),
      createTable("purchases", ["id", "customer_id"]),
    ]);

    const result = getExtendedLineage(ast as Select, schema);

    // Dataset lineage should include JOIN conditions from both queries
    const joinLineage = findBySubtype(result.dataset, "JOIN");
    // Each JOIN contributes 2 fields (from ON condition)
    expect(joinLineage.length).toBeGreaterThanOrEqual(4);
  });
});

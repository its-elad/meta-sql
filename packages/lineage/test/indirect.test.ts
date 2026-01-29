import { describe, test, expect } from "bun:test";
import { Parser } from "node-sql-parser";
import type { AST, Select } from "node-sql-parser";
import {
  getExtendedLineage,
  getJoinLineage,
  getFilterLineage,
  getGroupByLineage,
  getOrderByLineage,
  getWindowLineage,
  getLineage,
  type Schema,
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

describe("Indirect Lineage - JOIN", () => {
  test("simple inner join", () => {
    const sql = `
      SELECT u.id, u.name, o.total
      FROM users u
      JOIN orders o ON u.id = o.user_id
    `;

    const ast = parseSQL(sql);
    const schema = createSchema("trino", [
      createTable("users", ["id", "name", "email"]),
      createTable("orders", ["id", "user_id", "total"]),
    ]);

    const joinLineage = getJoinLineage(ast as Select, schema);

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

  test("multiple joins", () => {
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

    const joinLineage = getJoinLineage(ast as Select, schema);

    // Should have join columns from all joins
    expect(joinLineage.length).toBeGreaterThanOrEqual(4);
  });
});

describe("Indirect Lineage - FILTER (WHERE)", () => {
  test("simple where clause", () => {
    const sql = `
      SELECT id, name
      FROM users
      WHERE status = 'active'
    `;

    const ast = parseSQL(sql);
    const schema = createSchema("trino", [createTable("users", ["id", "name", "status"])]);

    const filterLineage = getFilterLineage(ast as Select, schema);

    expect(filterLineage).toContainEqual({
      namespace: "trino",
      name: "users",
      field: "status",
      transformations: [INDIRECT_FILTER],
    });
  });

  test("complex where clause with AND/OR", () => {
    const sql = `
      SELECT id, name
      FROM users
      WHERE status = 'active' AND age > 18 OR country = 'US'
    `;

    const ast = parseSQL(sql);
    const schema = createSchema("trino", [createTable("users", ["id", "name", "status", "age", "country"])]);

    const filterLineage = getFilterLineage(ast as Select, schema);

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

    expect(filterLineage).toContainEqual({
      namespace: "trino",
      name: "users",
      field: "country",
      transformations: [INDIRECT_FILTER],
    });
  });
});

describe("Indirect Lineage - GROUP BY", () => {
  test("simple group by", () => {
    const sql = `
      SELECT country, COUNT(*) as user_count
      FROM users
      GROUP BY country
    `;

    const ast = parseSQL(sql);
    const schema = createSchema("trino", [createTable("users", ["id", "name", "country"])]);

    const groupByLineage = getGroupByLineage(ast as Select, schema);

    expect(groupByLineage).toContainEqual({
      namespace: "trino",
      name: "users",
      field: "country",
      transformations: [INDIRECT_GROUP_BY],
    });
  });

  test("multiple group by columns", () => {
    const sql = `
      SELECT country, city, COUNT(*) as user_count
      FROM users
      GROUP BY country, city
    `;

    const ast = parseSQL(sql);
    const schema = createSchema("trino", [createTable("users", ["id", "name", "country", "city"])]);

    const groupByLineage = getGroupByLineage(ast as Select, schema);

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
});

describe("Indirect Lineage - ORDER BY (SORT)", () => {
  test("simple order by", () => {
    const sql = `
      SELECT id, name
      FROM users
      ORDER BY created_at DESC
    `;

    const ast = parseSQL(sql);
    const schema = createSchema("trino", [createTable("users", ["id", "name", "created_at"])]);

    const orderByLineage = getOrderByLineage(ast as Select, schema);

    expect(orderByLineage).toContainEqual({
      namespace: "trino",
      name: "users",
      field: "created_at",
      transformations: [INDIRECT_SORT],
    });
  });

  test("multiple order by columns", () => {
    const sql = `
      SELECT id, name
      FROM users
      ORDER BY country ASC, created_at DESC
    `;

    const ast = parseSQL(sql);
    const schema = createSchema("trino", [createTable("users", ["id", "name", "country", "created_at"])]);

    const orderByLineage = getOrderByLineage(ast as Select, schema);

    expect(orderByLineage).toContainEqual({
      namespace: "trino",
      name: "users",
      field: "country",
      transformations: [INDIRECT_SORT],
    });

    expect(orderByLineage).toContainEqual({
      namespace: "trino",
      name: "users",
      field: "created_at",
      transformations: [INDIRECT_SORT],
    });
  });
});

describe("Extended Lineage", () => {
  test("full query with all indirect types", () => {
    const sql = `
      SELECT 
        u.country,
        COUNT(u.id) as user_count,
        SUM(o.total) as total_revenue
      FROM users u
      JOIN orders o ON u.id = o.user_id
      WHERE u.status = 'active'
      GROUP BY u.country
      ORDER BY u.country DESC
    `;

    const ast = parseSQL(sql);
    const schema = createSchema("trino", [
      createTable("users", ["id", "name", "country", "status"]),
      createTable("orders", ["id", "user_id", "total"]),
    ]);

    const extendedLineage = getExtendedLineage(ast as Select, schema);

    // Check field-level lineage
    expect(extendedLineage.fields.country).toBeDefined();
    expect(extendedLineage.fields.user_count).toBeDefined();
    expect(extendedLineage.fields.total_revenue).toBeDefined();

    // Check dataset-level lineage contains indirect transformations
    expect(extendedLineage.dataset).toBeDefined();
    expect(extendedLineage.dataset!.length).toBeGreaterThan(0);

    // Should have JOIN lineage
    const joinFields = extendedLineage.dataset!.filter((f) => f.transformations?.[0]?.subtype === "JOIN");
    expect(joinFields.length).toBeGreaterThan(0);

    // Should have FILTER lineage
    const filterFields = extendedLineage.dataset!.filter((f) => f.transformations?.[0]?.subtype === "FILTER");
    expect(filterFields.length).toBeGreaterThan(0);

    // Should have GROUP_BY lineage
    const groupByFields = extendedLineage.dataset!.filter((f) => f.transformations?.[0]?.subtype === "GROUP_BY");
    expect(groupByFields.length).toBeGreaterThan(0);

    // Should have SORT lineage
    const sortFields = extendedLineage.dataset!.filter((f) => f.transformations?.[0]?.subtype === "SORT");
    expect(sortFields.length).toBeGreaterThan(0);
  });
});

describe("Direct Lineage - CASE/CONDITION", () => {
  test("simple case when", () => {
    const sql = `
      SELECT 
        id,
        CASE 
          WHEN status = 'active' THEN 'Active User'
          WHEN status = 'inactive' THEN 'Inactive User'
          ELSE 'Unknown'
        END as status_label
      FROM users
    `;

    const ast = parseSQL(sql);
    const schema = createSchema("trino", [createTable("users", ["id", "name", "status"])]);

    const lineage = getLineage(ast as Select, schema);

    // The status column should be in the lineage for status_label
    expect(lineage.status_label).toBeDefined();
    expect(lineage.status_label?.inputFields.length).toBeGreaterThan(0);

    // Should have CONDITION transformation for the condition columns
    const hasCondition = lineage.status_label?.inputFields.some(
      (f) =>
        f.transformations?.some((t) => t.subtype === "CONDITION") ||
        f.transformations?.some((t) => t.subtype === "TRANSFORMATION"),
    );
    expect(hasCondition).toBe(true);
  });

  test("case with expression in result", () => {
    const sql = `
      SELECT 
        id,
        CASE 
          WHEN quantity > 100 THEN price * 0.9
          ELSE price
        END as final_price
      FROM products
    `;

    const ast = parseSQL(sql);
    const schema = createSchema("trino", [createTable("products", ["id", "price", "quantity"])]);

    const lineage = getLineage(ast as Select, schema);

    expect(lineage.final_price).toBeDefined();

    // Should include both quantity (condition) and price (result)
    const fields = lineage.final_price?.inputFields.map((f) => f.field);
    expect(fields).toContain("price");
    expect(fields).toContain("quantity");
  });
});

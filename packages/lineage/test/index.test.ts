import { describe, test, expect } from "bun:test";
import { Parser } from "node-sql-parser";
import type { AST, Select } from "node-sql-parser";
import {
  getLineage,
  type Schema,
  type Table,
  DIRECT_AGGREGATION,
  DIRECT_IDENTITY,
  DIRECT_TRANSFORMATION,
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

describe("Select Lineage", () => {
  test("select from cte", () => {
    const sql = `
    WITH u AS (
      SELECT 
        id,
        name
      FROM users
    ) 
    SELECT 
      id,
      name as wow
    FROM u
    `;
    const ast = parseSQL(sql);
    const schema = createSchema("trino", [createTable("users", ["id", "name", "email"])]);

    const lineage = getLineage(ast as Select, schema);

    expect(lineage).toEqual({
      id: {
        inputFields: [
          {
            name: "users",
            namespace: "trino",
            field: "id",
            transformations: [DIRECT_IDENTITY],
          },
        ],
      },
      wow: {
        inputFields: [
          {
            name: "users",
            namespace: "trino",
            field: "name",
            transformations: [DIRECT_IDENTITY],
          },
        ],
      },
    });
  });

  test("select from cte with *", () => {
    const sql = `
                WITH u AS (
                  SELECT * FROM users
                )
                SELECT 
                  id,
                  name as wow
                FROM (SELECT * FROM u) AS t`;
    const ast = parseSQL(sql);
    const schema = createSchema("trino", [createTable("users", ["id", "name", "email"])]);

    const lineage = getLineage(ast as Select, schema);

    expect(lineage).toEqual({
      id: {
        inputFields: [
          {
            name: "users",
            namespace: "trino",
            field: "id",
            transformations: [DIRECT_IDENTITY],
          },
        ],
      },
      wow: {
        inputFields: [
          {
            name: "users",
            namespace: "trino",
            field: "name",
            transformations: [DIRECT_IDENTITY],
          },
        ],
      },
    });
  });

  test("select from multiple ctes", () => {
    const sql = `
    WITH active_users AS (
      SELECT 
        id,
        name,
        email
      FROM users
      WHERE status = 'active'
    ),
    user_orders AS (
      SELECT 
        user_id,
        COUNT(user_id) as order_count,
        SUM(total) as total_spent
      FROM orders
      GROUP BY user_id
    ),
    enriched_users AS (
      SELECT 
        au.id,
        au.name,
        au.email,
        COALESCE(uo.order_count, 0) as order_count,
        COALESCE(uo.total_spent, 0) as total_spent
      FROM active_users au
      LEFT JOIN user_orders uo ON au.id = uo.user_id
    )
    SELECT 
      id,
      name as full_name,
      order_count,
      total_spent * 1.1 as total_with_tax
    FROM enriched_users
    WHERE order_count > 0
    `;

    const ast = parseSQL(sql);
    const schema = createSchema("trino", [
      createTable("users", ["id", "name", "email", "status"]),
      createTable("orders", ["id", "user_id", "total"]),
    ]);

    const lineage = getLineage(ast as Select, schema);

    expect(lineage).toEqual({
      id: {
        inputFields: [
          {
            name: "users",
            namespace: "trino",
            field: "id",
            transformations: [DIRECT_IDENTITY],
          },
        ],
      },
      full_name: {
        inputFields: [
          {
            name: "users",
            namespace: "trino",
            field: "name",
            transformations: [DIRECT_IDENTITY],
          },
        ],
      },
      order_count: {
        inputFields: [
          {
            name: "orders",
            namespace: "trino",
            field: "user_id",
            transformations: [{ type: "DIRECT", subtype: "AGGREGATION", masking: true }],
          },
        ],
      },
      total_with_tax: {
        inputFields: [
          {
            name: "orders",
            namespace: "trino",
            field: "total",
            transformations: [DIRECT_AGGREGATION],
          },
        ],
      },
    });
  });

  test("product sales analysis with multiple ctes", () => {
    const sql = `-- Product sales analysis with store information using CTEs
WITH filtered_sales AS (
    SELECT 
        product_id,
        store_id,
        quantity_sold,
        unit_price,
        discount_percentage
    FROM product_sales 
    WHERE sale_date >= '2023-01-01'
),
store_sales_summary AS (
    SELECT 
        fs.product_id,
        fs.store_id,
        SUM(fs.quantity_sold) as total_quantity,
        AVG(fs.unit_price) as avg_price,
        SUM(fs.quantity_sold * fs.unit_price * (1 - fs.discount_percentage/100)) as net_revenue
    FROM filtered_sales fs
    GROUP BY fs.product_id, fs.store_id
),
final_report AS (
    SELECT 
        sss.product_id,
        s.store_name,
        s.region,
        sss.total_quantity,
        sss.avg_price,
        sss.net_revenue
    FROM store_sales_summary sss
    JOIN stores s ON sss.store_id = s.id
)
SELECT 
    product_id,
    store_name,
    region,
    total_quantity,
    avg_price,
    net_revenue
FROM final_report
ORDER BY net_revenue DESC`;

    const ast = parseSQL(sql);
    const schema = createSchema("trino", [
      createTable("product_sales", [
        "product_id",
        "store_id",
        "quantity_sold",
        "unit_price",
        "discount_percentage",
        "sale_date",
      ]),
      createTable("stores", ["id", "store_name", "region"]),
    ]);

    const lineage = getLineage(ast as Select, schema);

    expect(lineage).toEqual({
      product_id: {
        inputFields: [
          {
            name: "product_sales",
            namespace: "trino",
            field: "product_id",
            transformations: [DIRECT_IDENTITY],
          },
        ],
      },
      store_name: {
        inputFields: [
          {
            name: "stores",
            namespace: "trino",
            field: "store_name",
            transformations: [DIRECT_IDENTITY],
          },
        ],
      },
      region: {
        inputFields: [
          {
            name: "stores",
            namespace: "trino",
            field: "region",
            transformations: [DIRECT_IDENTITY],
          },
        ],
      },
      total_quantity: {
        inputFields: [
          {
            name: "product_sales",
            namespace: "trino",
            field: "quantity_sold",
            transformations: [DIRECT_AGGREGATION],
          },
        ],
      },
      avg_price: {
        inputFields: [
          {
            name: "product_sales",
            namespace: "trino",
            field: "unit_price",
            transformations: [DIRECT_AGGREGATION],
          },
        ],
      },
      net_revenue: {
        inputFields: [
          {
            name: "product_sales",
            namespace: "trino",
            field: "quantity_sold",
            transformations: [DIRECT_AGGREGATION],
          },
          {
            name: "product_sales",
            namespace: "trino",
            field: "unit_price",
            transformations: [DIRECT_AGGREGATION],
          },
          {
            name: "product_sales",
            namespace: "trino",
            field: "discount_percentage",
            transformations: [DIRECT_AGGREGATION],
          },
        ],
      },
    });
  });

  test("select with lots of aliases", () => {
    const sql = `
    WITH u AS (
      SELECT 
        id as i,
        name as n
      FROM users
    ) 
    SELECT 
      i as id,
      n as wow
    FROM u
    `;

    const ast = parseSQL(sql);
    const schema = createSchema("trino", [createTable("users", ["id", "name", "email"])]);

    const lineage = getLineage(ast as Select, schema);

    expect(lineage).toEqual({
      id: {
        inputFields: [
          {
            name: "users",
            namespace: "trino",
            field: "id",
            transformations: [DIRECT_IDENTITY],
          },
        ],
      },
      wow: {
        inputFields: [
          {
            name: "users",
            namespace: "trino",
            field: "name",
            transformations: [DIRECT_IDENTITY],
          },
        ],
      },
    });
  });

  test("select with group by", () => {
    const sql = `SELECT country, count(city) as city_count
      FROM cities
      GROUP BY country`;

    const ast = parseSQL(sql);
    const schema = createSchema("trino", [createTable("cities", ["country", "city"])]);

    const lineage = getLineage(ast as Select, schema);

    expect(lineage).toEqual({
      country: {
        inputFields: [
          {
            name: "cities",
            namespace: "trino",
            field: "country",
            transformations: [DIRECT_IDENTITY],
          },
        ],
      },
      city_count: {
        inputFields: [
          {
            name: "cities",
            namespace: "trino",
            field: "city",
            transformations: [{ type: "DIRECT", subtype: "AGGREGATION", masking: true }],
          },
        ],
      },
    });
  });

  test("select with binary expression", () => {
    const sql = `SELECT id, name, id + 1 as next_id
      FROM users`;

    const ast = parseSQL(sql);
    const schema = createSchema("trino", [createTable("users", ["id", "name"])]);

    const lineage = getLineage(ast as Select, schema);

    expect(lineage).toEqual({
      id: {
        inputFields: [
          {
            name: "users",
            namespace: "trino",
            field: "id",
            transformations: [DIRECT_IDENTITY],
          },
        ],
      },
      name: {
        inputFields: [
          {
            name: "users",
            namespace: "trino",
            field: "name",
            transformations: [DIRECT_IDENTITY],
          },
        ],
      },
      next_id: {
        inputFields: [
          {
            name: "users",
            namespace: "trino",
            field: "id",
            transformations: [DIRECT_TRANSFORMATION],
          },
        ],
      },
    });
  });

  test("select same column different tables", () => {
    const sql = `SELECT u.id, o.id as order_id
      FROM users u
      JOIN orders o ON u.id = o.user_id`;

    const ast = parseSQL(sql);
    const schema = createSchema("trino", [
      createTable("users", ["id", "name", "email"]),
      createTable("orders", ["id", "user_id", "total"]),
    ]);

    const lineage = getLineage(ast as Select, schema);

    expect(lineage).toEqual({
      id: {
        inputFields: [
          {
            name: "users",
            namespace: "trino",
            field: "id",
            transformations: [DIRECT_IDENTITY],
          },
        ],
      },
      order_id: {
        inputFields: [
          {
            name: "orders",
            namespace: "trino",
            field: "id",
            transformations: [DIRECT_IDENTITY],
          },
        ],
      },
    });
  });

  test("select with function transformation", () => {
    const sql = `SELECT 
      id,
      UPPER(name) as upper_name,
      LENGTH(email) as email_length,
      CONCAT(name, email) as name_email
    FROM users`;

    const ast = parseSQL(sql);
    const schema = createSchema("trino", [createTable("users", ["id", "name", "email"])]);

    const lineage = getLineage(ast as Select, schema);

    expect(lineage).toEqual({
      id: {
        inputFields: [
          {
            name: "users",
            namespace: "trino",
            field: "id",
            transformations: [DIRECT_IDENTITY],
          },
        ],
      },
      upper_name: {
        inputFields: [
          {
            name: "users",
            namespace: "trino",
            field: "name",
            transformations: [DIRECT_TRANSFORMATION],
          },
        ],
      },
      email_length: {
        inputFields: [
          {
            name: "users",
            namespace: "trino",
            field: "email",
            transformations: [DIRECT_TRANSFORMATION],
          },
        ],
      },
      name_email: {
        inputFields: [
          {
            name: "users",
            namespace: "trino",
            field: "name",
            transformations: [DIRECT_TRANSFORMATION],
          },
          {
            name: "users",
            namespace: "trino",
            field: "email",
            transformations: [DIRECT_TRANSFORMATION],
          },
        ],
      },
    });
  });

  test("select with arithmetic operations", () => {
    const sql = `SELECT 
      id,
      price + tax as total_price,
      quantity * price as line_total,
      (price + tax) * quantity as grand_total,
      price - discount as discounted_price
    FROM orders`;

    const ast = parseSQL(sql);
    const schema = createSchema("trino", [createTable("orders", ["id", "price", "tax", "quantity", "discount"])]);

    const lineage = getLineage(ast as Select, schema);

    expect(lineage).toEqual({
      id: {
        inputFields: [
          {
            name: "orders",
            namespace: "trino",
            field: "id",
            transformations: [DIRECT_IDENTITY],
          },
        ],
      },
      total_price: {
        inputFields: [
          {
            name: "orders",
            namespace: "trino",
            field: "price",
            transformations: [DIRECT_TRANSFORMATION],
          },
          {
            name: "orders",
            namespace: "trino",
            field: "tax",
            transformations: [DIRECT_TRANSFORMATION],
          },
        ],
      },
      line_total: {
        inputFields: [
          {
            name: "orders",
            namespace: "trino",
            field: "quantity",
            transformations: [DIRECT_TRANSFORMATION],
          },
          {
            name: "orders",
            namespace: "trino",
            field: "price",
            transformations: [DIRECT_TRANSFORMATION],
          },
        ],
      },
      grand_total: {
        inputFields: [
          {
            name: "orders",
            namespace: "trino",
            field: "price",
            transformations: [DIRECT_TRANSFORMATION],
          },
          {
            name: "orders",
            namespace: "trino",
            field: "tax",
            transformations: [DIRECT_TRANSFORMATION],
          },
          {
            name: "orders",
            namespace: "trino",
            field: "quantity",
            transformations: [DIRECT_TRANSFORMATION],
          },
        ],
      },
      discounted_price: {
        inputFields: [
          {
            name: "orders",
            namespace: "trino",
            field: "price",
            transformations: [DIRECT_TRANSFORMATION],
          },
          {
            name: "orders",
            namespace: "trino",
            field: "discount",
            transformations: [DIRECT_TRANSFORMATION],
          },
        ],
      },
    });
  });

  test("select with complex nested arithmetic", () => {
    const sql = `SELECT 
      id,
      ((price + tax) * quantity) / discount as complex_calc,
      price % 10 as price_remainder
    FROM orders`;

    const ast = parseSQL(sql);
    const schema = createSchema("trino", [createTable("orders", ["id", "price", "tax", "quantity", "discount"])]);

    const lineage = getLineage(ast as Select, schema);

    expect(lineage).toEqual({
      id: {
        inputFields: [
          {
            name: "orders",
            namespace: "trino",
            field: "id",
            transformations: [DIRECT_IDENTITY],
          },
        ],
      },
      complex_calc: {
        inputFields: [
          {
            name: "orders",
            namespace: "trino",
            field: "price",
            transformations: [DIRECT_TRANSFORMATION],
          },
          {
            name: "orders",
            namespace: "trino",
            field: "tax",
            transformations: [DIRECT_TRANSFORMATION],
          },
          {
            name: "orders",
            namespace: "trino",
            field: "quantity",
            transformations: [DIRECT_TRANSFORMATION],
          },
          {
            name: "orders",
            namespace: "trino",
            field: "discount",
            transformations: [DIRECT_TRANSFORMATION],
          },
        ],
      },
      price_remainder: {
        inputFields: [
          {
            name: "orders",
            namespace: "trino",
            field: "price",
            transformations: [DIRECT_TRANSFORMATION],
          },
        ],
      },
    });
  });

  test("select with mixed aggregation and arithmetic", () => {
    const sql = `SELECT 
      country,
      SUM(population) as total_population,
      AVG(area) * 2 as double_avg_area,
      COUNT(city) + 1 as city_count_plus_one
    FROM cities
    GROUP BY country`;

    const ast = parseSQL(sql);
    const schema = createSchema("trino", [createTable("cities", ["country", "city", "population", "area"])]);

    const lineage = getLineage(ast as Select, schema);

    expect(lineage).toEqual({
      country: {
        inputFields: [
          {
            name: "cities",
            namespace: "trino",
            field: "country",
            transformations: [DIRECT_IDENTITY],
          },
        ],
      },
      total_population: {
        inputFields: [
          {
            name: "cities",
            namespace: "trino",
            field: "population",
            transformations: [{ ...DIRECT_AGGREGATION }],
          },
        ],
      },
      double_avg_area: {
        inputFields: [
          {
            name: "cities",
            namespace: "trino",
            field: "area",
            transformations: [DIRECT_AGGREGATION],
          },
        ],
      },
      city_count_plus_one: {
        inputFields: [
          {
            name: "cities",
            namespace: "trino",
            field: "city",
            transformations: [{ ...DIRECT_AGGREGATION, masking: true }],
          },
        ],
      },
    });
  });

  test("select * from single table", () => {
    const sql = `SELECT * FROM users`;
    const ast = parseSQL(sql);
    const schema = createSchema("trino", [createTable("users", ["id", "name", "email"])]);

    const lineage = getLineage(ast as Select, schema);

    expect(lineage).toEqual({
      id: {
        inputFields: [
          {
            name: "users",
            namespace: "trino",
            field: "id",
            transformations: [DIRECT_IDENTITY],
          },
        ],
      },
      name: {
        inputFields: [
          {
            name: "users",
            namespace: "trino",
            field: "name",
            transformations: [DIRECT_IDENTITY],
          },
        ],
      },
      email: {
        inputFields: [
          {
            name: "users",
            namespace: "trino",
            field: "email",
            transformations: [DIRECT_IDENTITY],
          },
        ],
      },
    });
  });

  test("select * from multiple tables (JOIN)", () => {
    const sql = `SELECT * FROM users u JOIN orders o ON u.id = o.user_id`;
    const ast = parseSQL(sql);
    const schema = createSchema("trino", [
      createTable("users", ["id", "name"]),
      createTable("orders", ["id", "user_id", "total"]),
    ]);

    const lineage = getLineage(ast as Select, schema);

    // Note: When both tables have "id", the second one (orders.id) overwrites the first (users.id)
    // This is expected behavior since the output column names would conflict
    expect(lineage).toEqual({
      id: {
        inputFields: [
          {
            name: "orders",
            namespace: "trino",
            field: "id",
            transformations: [DIRECT_IDENTITY],
          },
        ],
      },
      name: {
        inputFields: [
          {
            name: "users",
            namespace: "trino",
            field: "name",
            transformations: [DIRECT_IDENTITY],
          },
        ],
      },
      user_id: {
        inputFields: [
          {
            name: "orders",
            namespace: "trino",
            field: "user_id",
            transformations: [DIRECT_IDENTITY],
          },
        ],
      },
      total: {
        inputFields: [
          {
            name: "orders",
            namespace: "trino",
            field: "total",
            transformations: [DIRECT_IDENTITY],
          },
        ],
      },
    });
  });

  test("select table.* from specific table", () => {
    const sql = `SELECT u.* FROM users u JOIN orders o ON u.id = o.user_id`;
    const ast = parseSQL(sql);
    const schema = createSchema("trino", [
      createTable("users", ["id", "name"]),
      createTable("orders", ["id", "user_id", "total"]),
    ]);

    const lineage = getLineage(ast as Select, schema);

    expect(lineage).toEqual({
      id: {
        inputFields: [
          {
            name: "users",
            namespace: "trino",
            field: "id",
            transformations: [DIRECT_IDENTITY],
          },
        ],
      },
      name: {
        inputFields: [
          {
            name: "users",
            namespace: "trino",
            field: "name",
            transformations: [DIRECT_IDENTITY],
          },
        ],
      },
    });
  });

  test("select * mixed with specific columns", () => {
    const sql = `SELECT o.*, u.name as user_name FROM users u JOIN orders o ON u.id = o.user_id`;
    const ast = parseSQL(sql);
    const schema = createSchema("trino", [
      createTable("users", ["id", "name"]),
      createTable("orders", ["id", "user_id", "total"]),
    ]);

    const lineage = getLineage(ast as Select, schema);

    expect(lineage).toEqual({
      id: {
        inputFields: [
          {
            name: "orders",
            namespace: "trino",
            field: "id",
            transformations: [DIRECT_IDENTITY],
          },
        ],
      },
      user_id: {
        inputFields: [
          {
            name: "orders",
            namespace: "trino",
            field: "user_id",
            transformations: [DIRECT_IDENTITY],
          },
        ],
      },
      total: {
        inputFields: [
          {
            name: "orders",
            namespace: "trino",
            field: "total",
            transformations: [DIRECT_IDENTITY],
          },
        ],
      },
      user_name: {
        inputFields: [
          {
            name: "users",
            namespace: "trino",
            field: "name",
            transformations: [DIRECT_IDENTITY],
          },
        ],
      },
    });
  });

  test("select * from CTE", () => {
    const sql = `
    WITH filtered_users AS (
      SELECT id, name FROM users WHERE active = true
    )
    SELECT * FROM filtered_users
    `;
    const ast = parseSQL(sql);
    const schema = createSchema("trino", [createTable("users", ["id", "name", "active"])]);

    const lineage = getLineage(ast as Select, schema);

    expect(lineage).toEqual({
      id: {
        inputFields: [
          {
            name: "users",
            namespace: "trino",
            field: "id",
            transformations: [DIRECT_IDENTITY],
          },
        ],
      },
      name: {
        inputFields: [
          {
            name: "users",
            namespace: "trino",
            field: "name",
            transformations: [DIRECT_IDENTITY],
          },
        ],
      },
    });
  });

  test("select * from nested subquery", () => {
    const sql = `SELECT * FROM (SELECT id, name FROM users) AS subq`;
    const ast = parseSQL(sql);
    const schema = createSchema("trino", [createTable("users", ["id", "name", "email"])]);

    const lineage = getLineage(ast as Select, schema);

    expect(lineage).toEqual({
      id: {
        inputFields: [
          {
            name: "users",
            namespace: "trino",
            field: "id",
            transformations: [DIRECT_IDENTITY],
          },
        ],
      },
      name: {
        inputFields: [
          {
            name: "users",
            namespace: "trino",
            field: "name",
            transformations: [DIRECT_IDENTITY],
          },
        ],
      },
    });
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

describe("Set Operations (UNION, INTERSECT, EXCEPT)", () => {
  test("simple UNION combines lineage from both queries", () => {
    const sql = `
      SELECT id, name FROM users
      UNION
      SELECT id, name FROM customers
    `;
    const ast = parseSQLPostgres(sql);
    const schema = createSchema("postgres", [
      createTable("users", ["id", "name", "email"]),
      createTable("customers", ["id", "name", "address"]),
    ]);

    const lineage = getLineage(ast as Select, schema);

    // Output columns are from the first SELECT, but input fields include both tables
    expect(lineage.id?.inputFields).toHaveLength(2);
    expect(lineage.id?.inputFields).toContainEqual({
      name: "users",
      namespace: "postgres",
      field: "id",
      transformations: [DIRECT_IDENTITY],
    });
    expect(lineage.id?.inputFields).toContainEqual({
      name: "customers",
      namespace: "postgres",
      field: "id",
      transformations: [DIRECT_IDENTITY],
    });

    expect(lineage.name?.inputFields).toHaveLength(2);
    expect(lineage.name?.inputFields).toContainEqual({
      name: "users",
      namespace: "postgres",
      field: "name",
      transformations: [DIRECT_IDENTITY],
    });
    expect(lineage.name?.inputFields).toContainEqual({
      name: "customers",
      namespace: "postgres",
      field: "name",
      transformations: [DIRECT_IDENTITY],
    });
  });

  test("UNION ALL combines lineage from both queries", () => {
    const sql = `
      SELECT id FROM users
      UNION ALL
      SELECT id FROM orders
    `;
    const ast = parseSQLPostgres(sql);
    const schema = createSchema("postgres", [
      createTable("users", ["id", "name"]),
      createTable("orders", ["id", "product"]),
    ]);

    const lineage = getLineage(ast as Select, schema);

    expect(lineage.id?.inputFields).toHaveLength(2);
    expect(lineage.id?.inputFields).toContainEqual({
      name: "users",
      namespace: "postgres",
      field: "id",
      transformations: [DIRECT_IDENTITY],
    });
    expect(lineage.id?.inputFields).toContainEqual({
      name: "orders",
      namespace: "postgres",
      field: "id",
      transformations: [DIRECT_IDENTITY],
    });
  });

  test("INTERSECT combines lineage from both queries", () => {
    const sql = `
      SELECT id FROM users
      INTERSECT
      SELECT id FROM premium_users
    `;
    const ast = parseSQLPostgres(sql);
    const schema = createSchema("postgres", [
      createTable("users", ["id", "name"]),
      createTable("premium_users", ["id", "tier"]),
    ]);

    const lineage = getLineage(ast as Select, schema);

    expect(lineage.id?.inputFields).toHaveLength(2);
    expect(lineage.id?.inputFields).toContainEqual({
      name: "users",
      namespace: "postgres",
      field: "id",
      transformations: [DIRECT_IDENTITY],
    });
    expect(lineage.id?.inputFields).toContainEqual({
      name: "premium_users",
      namespace: "postgres",
      field: "id",
      transformations: [DIRECT_IDENTITY],
    });
  });

  test("EXCEPT combines lineage from both queries", () => {
    const sql = `
      SELECT id FROM users
      EXCEPT
      SELECT id FROM banned_users
    `;
    const ast = parseSQLPostgres(sql);
    const schema = createSchema("postgres", [
      createTable("users", ["id", "name"]),
      createTable("banned_users", ["id", "reason"]),
    ]);

    const lineage = getLineage(ast as Select, schema);

    expect(lineage.id?.inputFields).toHaveLength(2);
    expect(lineage.id?.inputFields).toContainEqual({
      name: "users",
      namespace: "postgres",
      field: "id",
      transformations: [DIRECT_IDENTITY],
    });
    expect(lineage.id?.inputFields).toContainEqual({
      name: "banned_users",
      namespace: "postgres",
      field: "id",
      transformations: [DIRECT_IDENTITY],
    });
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
    const schema = createSchema("postgres", [
      createTable("users", ["id", "name"]),
      createTable("customers", ["id", "name"]),
      createTable("vendors", ["id", "name"]),
    ]);

    const lineage = getLineage(ast as Select, schema);

    // All three tables contribute to the lineage
    expect(lineage.id?.inputFields).toHaveLength(3);
    expect(lineage.name?.inputFields).toHaveLength(3);
  });

  test("UNION with aliases preserves first SELECT column names", () => {
    const sql = `
      SELECT id AS user_id, name AS full_name FROM users
      UNION
      SELECT customer_id, customer_name FROM customers
    `;
    const ast = parseSQLPostgres(sql);
    const schema = createSchema("postgres", [
      createTable("users", ["id", "name"]),
      createTable("customers", ["customer_id", "customer_name"]),
    ]);

    const lineage = getLineage(ast as Select, schema);

    // Output columns should be named according to the first SELECT
    expect(Object.keys(lineage)).toEqual(["user_id", "full_name"]);
    expect(lineage.user_id?.inputFields).toContainEqual({
      name: "users",
      namespace: "postgres",
      field: "id",
      transformations: [DIRECT_IDENTITY],
    });
    expect(lineage.user_id?.inputFields).toContainEqual({
      name: "customers",
      namespace: "postgres",
      field: "customer_id",
      transformations: [DIRECT_IDENTITY],
    });
  });

  test("UNION with transformations", () => {
    const sql = `
      SELECT UPPER(name) AS name FROM users
      UNION
      SELECT LOWER(name) AS name FROM customers
    `;
    const ast = parseSQLPostgres(sql);
    const schema = createSchema("postgres", [
      createTable("users", ["id", "name"]),
      createTable("customers", ["id", "name"]),
    ]);

    const lineage = getLineage(ast as Select, schema);

    // Both inputs should have TRANSFORMATION type
    expect(lineage.name?.inputFields).toHaveLength(2);
    expect(lineage.name?.inputFields).toContainEqual({
      name: "users",
      namespace: "postgres",
      field: "name",
      transformations: [DIRECT_TRANSFORMATION],
    });
    expect(lineage.name?.inputFields).toContainEqual({
      name: "customers",
      namespace: "postgres",
      field: "name",
      transformations: [DIRECT_TRANSFORMATION],
    });
  });

  test("UNION with aggregation", () => {
    const sql = `
      SELECT SUM(amount) AS total FROM sales
      UNION
      SELECT SUM(amount) AS total FROM refunds
    `;
    const ast = parseSQLPostgres(sql);
    const schema = createSchema("postgres", [
      createTable("sales", ["id", "amount"]),
      createTable("refunds", ["id", "amount"]),
    ]);

    const lineage = getLineage(ast as Select, schema);

    expect(lineage.total?.inputFields).toHaveLength(2);
    expect(lineage.total?.inputFields).toContainEqual({
      name: "sales",
      namespace: "postgres",
      field: "amount",
      transformations: [DIRECT_AGGREGATION],
    });
    expect(lineage.total?.inputFields).toContainEqual({
      name: "refunds",
      namespace: "postgres",
      field: "amount",
      transformations: [DIRECT_AGGREGATION],
    });
  });

  test("UNION with different column expressions", () => {
    const sql = `
      SELECT id, first_name || ' ' || last_name AS full_name FROM users
      UNION
      SELECT id, company_name FROM customers
    `;
    const ast = parseSQLPostgres(sql);
    const schema = createSchema("postgres", [
      createTable("users", ["id", "first_name", "last_name"]),
      createTable("customers", ["id", "company_name"]),
    ]);

    const lineage = getLineage(ast as Select, schema);

    // First SELECT contributes first_name and last_name, second contributes company_name
    expect(lineage.full_name?.inputFields.length).toBeGreaterThanOrEqual(3);
  });

  test("UNION with subqueries", () => {
    const sql = `
      SELECT id FROM (SELECT id FROM users WHERE active = true) AS active_users
      UNION
      SELECT id FROM (SELECT id FROM customers WHERE verified = true) AS verified_customers
    `;
    const ast = parseSQLPostgres(sql);
    const schema = createSchema("postgres", [
      createTable("users", ["id", "active"]),
      createTable("customers", ["id", "verified"]),
    ]);

    const lineage = getLineage(ast as Select, schema);

    expect(lineage.id?.inputFields).toHaveLength(2);
  });

  test("UNION deduplicates identical input fields", () => {
    const sql = `
      SELECT id FROM users
      UNION
      SELECT id FROM users
    `;
    const ast = parseSQLPostgres(sql);
    const schema = createSchema("postgres", [createTable("users", ["id", "name"])]);

    const lineage = getLineage(ast as Select, schema);

    // Same table appears in both SELECTs, but should be deduplicated
    expect(lineage.id?.inputFields).toHaveLength(1);
    expect(lineage.id?.inputFields).toContainEqual({
      name: "users",
      namespace: "postgres",
      field: "id",
      transformations: [DIRECT_IDENTITY],
    });
  });
});

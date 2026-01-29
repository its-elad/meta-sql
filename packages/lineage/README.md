# @meta-sql/lineage

A TypeScript library for extracting column-level and dataset-level lineage from SQL queries, implementing the [OpenLineage Column Lineage Dataset Facet specification](https://openlineage.io/docs/spec/facets/dataset-facets/column_lineage_facet/).

> ⚠️ **Experimental**: This library is currently in active development and may undergo significant changes. APIs, interfaces, and functionality may change without notice in future versions. Use with caution in production environments.

## Overview

This library analyzes SQL SELECT statements to generate detailed lineage information:

- **Field-level lineage**: Tracks how data flows from input columns to output columns through transformations
- **Dataset-level lineage**: Tracks columns that indirectly affect the entire result set (JOINs, filters, grouping, sorting, window functions)

## Features

- ✅ **Column-level lineage extraction** from SQL SELECT statements
- ✅ **Dataset-level indirect lineage** for columns affecting the entire result
- ✅ **CTE (Common Table Expression) support** with nested lineage tracking
- ✅ **Direct transformations** (IDENTITY, TRANSFORMATION, AGGREGATION)
- ✅ **Indirect transformations** (JOIN, FILTER, GROUP_BY, SORT, WINDOW, CONDITION)
- ✅ **Window function support** (PARTITION BY, ORDER BY in OVER clauses)
- ✅ **Masking detection** for privacy-preserving transformations
- ✅ **Schema-aware parsing** with table and column validation
- ✅ **OpenLineage specification compliance** for interoperability
- ✅ **TypeScript-first** with comprehensive type definitions

## Installation

```bash
npm install @meta-sql/lineage node-sql-parser
# or
bun add @meta-sql/lineage node-sql-parser
```

## Quick Start

### Basic Field-Level Lineage

```typescript
import { getLineage } from "@meta-sql/lineage";
import { Parser } from "node-sql-parser";

const parser = new Parser();
const ast = parser.astify("SELECT id, name FROM users") as Select;

const schema = {
  namespace: "my_database",
  tables: [{ name: "users", columns: ["id", "name", "email"] }],
};

const lineage = getLineage(ast, schema);
// Returns field-level lineage only
```

### Extended Lineage (Field + Dataset Level)

```typescript
import { getExtendedLineage } from "@meta-sql/lineage";
import { Parser } from "node-sql-parser";

const parser = new Parser();
const sql = `
  SELECT u.name, COUNT(o.id) as order_count
  FROM users u
  JOIN orders o ON u.id = o.user_id
  WHERE u.status = 'active'
  GROUP BY u.name
  ORDER BY order_count DESC
`;
const ast = parser.astify(sql, { database: "trino" }) as Select;

const schema = {
  namespace: "my_database",
  tables: [
    { name: "users", columns: ["id", "name", "status"] },
    { name: "orders", columns: ["id", "user_id", "total"] },
  ],
};

const result = getExtendedLineage(ast, schema);

// result.fields - Field-level lineage (which columns flow into output columns)
// {
//   name: { inputFields: [{ field: "name", name: "users", ... }] },
//   order_count: { inputFields: [{ field: "id", name: "orders", transformations: [AGGREGATION] }] }
// }

// result.dataset - Dataset-level lineage (columns that indirectly affect the result)
// [
//   { field: "id", name: "users", transformations: [{ type: "INDIRECT", subtype: "JOIN" }] },
//   { field: "user_id", name: "orders", transformations: [{ type: "INDIRECT", subtype: "JOIN" }] },
//   { field: "status", name: "users", transformations: [{ type: "INDIRECT", subtype: "FILTER" }] },
//   { field: "name", name: "users", transformations: [{ type: "INDIRECT", subtype: "GROUP_BY" }] }
// ]
```

## Transformation Types

### Direct Transformations (Field-Level)

| Subtype | Description | Example |
|---------|-------------|---------|
| `IDENTITY` | Column passed through unchanged | `SELECT id FROM users` |
| `TRANSFORMATION` | Column modified by function/expression | `SELECT UPPER(name)`, `SELECT price * qty` |
| `AGGREGATION` | Column aggregated | `SELECT SUM(amount)`, `SELECT COUNT(id)` |

### Indirect Transformations (Dataset-Level)

| Subtype | Description | Example |
|---------|-------------|---------|
| `JOIN` | Columns used in JOIN conditions | `ON u.id = o.user_id` |
| `FILTER` | Columns used in WHERE/HAVING | `WHERE status = 'active'` |
| `GROUP_BY` | Columns used in GROUP BY | `GROUP BY department` |
| `SORT` | Columns used in ORDER BY | `ORDER BY created_at` |
| `WINDOW` | Columns in OVER clause | `OVER (PARTITION BY dept ORDER BY salary)` |
| `CONDITION` | Columns in CASE WHEN conditions | `CASE WHEN status = 'x' THEN ...` |

## Supported SQL Features

### ✅ Currently Supported

- Basic SELECT statements
- Column aliases (`SELECT id as user_id`)
- Common Table Expressions (CTEs) with lineage propagation
- Nested subqueries
- JOINs (INNER, LEFT, RIGHT) with ON conditions
- WHERE and HAVING clauses
- GROUP BY with aggregations
- ORDER BY sorting
- Window functions (`ROW_NUMBER`, `RANK`, `SUM OVER`, etc.)
- CASE WHEN expressions
- CAST and type conversions
- Mathematical operations (`SELECT price * quantity`)
- String functions (`SELECT UPPER(name)`)
- Date functions (`SELECT DATE_TRUNC('month', created_at)`)
- Masking functions (`MD5`, `SHA256`, `HASH`, `MASK`, `ANONYMIZE`, etc.)

### 🔄 In Progress

- UNION and INTERSECT operations
- More complex recursive CTE patterns

### 📋 Planned

- FULL OUTER JOIN support
- Multi-statement support (DDL operations)
- `select *` support
- Additional SQL dialect optimizations

## API Reference

### `getLineage(select, schema)`

Extracts field-level column lineage from a SQL SELECT AST.

```typescript
function getLineage(select: Select, schema: Schema): ColumnLineageDatasetFacet["fields"];
```

### `getExtendedLineage(select, schema)`

Extracts both field-level and dataset-level lineage.

```typescript
function getExtendedLineage(select: Select, schema: Schema): ExtendedLineageResult;

interface ExtendedLineageResult {
  fields: ColumnLineageDatasetFacet["fields"]; // Field-level lineage
  dataset?: InputField[]; // Dataset-level indirect lineage
}
```

### Types

```typescript
type Schema = {
  namespace: string;
  tables: Table[];
};

type Table = {
  name: string;
  columns: string[];
};

type Transformation = {
  type: "DIRECT" | "INDIRECT";
  subtype: "IDENTITY" | "TRANSFORMATION" | "AGGREGATION" | "JOIN" | "FILTER" | "GROUP_BY" | "SORT" | "WINDOW" | "CONDITION";
  masking: boolean;
};
```

## Roadmap

### ✅ Completed

- Field-level lineage with DIRECT transformations
- Dataset-level lineage with INDIRECT transformations
- Window function support
- CTE lineage propagation
- Masking detection

### 🔄 In Progress

- UNION and INTERSECT operations
- More complex recursive CTE patterns

### 📋 Planned

- Multi-statement support (DDL operations)
- Additional SQL dialect optimizations

## License

MIT License - see [LICENSE](../../LICENSE) for details.

// Loads a fixture (tables of JSON rows) into a SQLite database shaped like a run file.
// Objects and arrays become JSON text, booleans become 0 or 1, as in a real snapshot.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

export type Rows = Record<string, unknown>[];

export interface Fixture {
  tables: Record<string, Rows>;
  /** expected status per "org/repo" */
  expect?: Record<string, string>;
  /** expected evidence keys per "org/repo", partial */
  evidence?: Record<string, Record<string, unknown>>;
}

export const FIXTURES = join(import.meta.dirname, "fixtures");

export const readFixture = (name: string): Fixture =>
  JSON.parse(readFileSync(join(FIXTURES, `${name}.json`), "utf8"));

const cell = (value: unknown): string | number | null => {
  if (value === null || value === undefined) return null;
  if (typeof value === "boolean") return value ? 1 : 0;
  if (typeof value === "object") return JSON.stringify(value);
  return value as string | number;
};

export function load(tables: Record<string, Rows>, path = ":memory:"): DatabaseSync {
  const db = new DatabaseSync(path);
  for (const [table, rows] of Object.entries(tables)) {
    const columns = [...new Set(rows.flatMap(Object.keys))];
    if (!columns.length) throw new Error(`fixture table ${table} needs at least one row`);
    db.exec(`CREATE TABLE "${table}" (${columns.map((c) => `"${c}"`).join(", ")})`);
    const insert = db.prepare(`INSERT INTO "${table}" VALUES (${columns.map(() => "?").join(", ")})`);
    for (const row of rows) insert.run(...columns.map((c) => cell(row[c])));
  }
  return db;
}

// Loads a fixture (tables of JSON rows) into a SQLite database shaped like a run file, through
// the same insert as the real snapshot, so JSON booleans and objects land the way StackQL rows do.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { insert } from "../src/snapshot.ts";

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

export function load(tables: Record<string, Rows>, path = ":memory:"): DatabaseSync {
  const db = new DatabaseSync(path);
  for (const [table, rows] of Object.entries(tables)) {
    const columns = [...new Set(rows.flatMap(Object.keys))];
    if (!columns.length) throw new Error(`fixture table ${table} needs at least one row`);
    insert(db, table, columns, rows);
  }
  return db;
}

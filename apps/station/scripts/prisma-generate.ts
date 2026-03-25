#!/usr/bin/env bun
/**
 * Detects SQLite vs PostgreSQL from DATABASE_URL and runs
 * prisma commands against the correct schema file.
 *
 * Usage: bun run scripts/prisma-generate.ts <prisma-args...>
 * Example: bun run scripts/prisma-generate.ts generate
 *          bun run scripts/prisma-generate.ts db push
 */

import { spawnSync } from "node:child_process";
import { resolve } from "node:path";

const url = process.env.DATABASE_URL ?? "";
const isSQLite = url.startsWith("file:") || (!url.startsWith("postgres://") && !url.startsWith("postgresql://"));

const schemaFile = isSQLite ? "prisma/schema.sqlite.prisma" : "prisma/schema.prisma";
const schemaPath = resolve(import.meta.dirname, "..", schemaFile);

const args = process.argv.slice(2);

console.log(`Using ${isSQLite ? "SQLite" : "PostgreSQL"} schema: ${schemaFile}`);

const result = spawnSync("bunx", ["prisma", ...args, `--schema=${schemaPath}`], {
  stdio: "inherit",
  env: process.env,
  cwd: resolve(import.meta.dirname, ".."),
});

process.exit(result.status ?? 1);

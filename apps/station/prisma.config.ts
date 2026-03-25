import { defineConfig } from "prisma/config";

const url = process.env.DATABASE_URL ?? "file:./data/clanker.db";
const isSQLite = url.startsWith("file:") || (!url.startsWith("postgres://") && !url.startsWith("postgresql://"));

export default defineConfig({
  schema: isSQLite ? "prisma/schema.sqlite.prisma" : "prisma/schema.prisma",
  migrations: {
    path: isSQLite ? "prisma/migrations/sqlite" : "prisma/migrations/pg",
  },
  datasource: { url },
});

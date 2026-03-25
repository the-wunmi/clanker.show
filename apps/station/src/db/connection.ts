import { PrismaClient } from "../generated/prisma/client";

let prisma: PrismaClient | null = null;

function detectSQLite(): boolean {
  const url = process.env.DATABASE_URL ?? "";
  return url.startsWith("file:") || (!url.startsWith("postgres://") && !url.startsWith("postgresql://"));
}

export async function initDb() {
  if (prisma) return;

  if (detectSQLite()) {
    const { PrismaBunSqlite } = await import("prisma-adapter-bun-sqlite");
    const adapter = new PrismaBunSqlite({
      url: process.env.DATABASE_URL || "file:./data/clanker.db",
    });
    prisma = new PrismaClient({ adapter });
  } else {
    const { PrismaPg } = await import("@prisma/adapter-pg");
    const adapter = new PrismaPg({
      connectionString: process.env.DATABASE_URL!,
    });
    prisma = new PrismaClient({ adapter });
  }

  await prisma.$connect();
}

export function getPrisma(): PrismaClient {
  if (!prisma) {
    throw new Error("Database not initialized. Call initDb() first.");
  }
  return prisma;
}

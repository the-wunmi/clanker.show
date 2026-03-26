import type { ApiKey as ApiKeyRow, Prisma } from "../../generated/prisma/client";
import { getPrisma } from "../connection";
import { createId } from "../id";
import { randomBytes, createHash } from "node:crypto";

export type { ApiKeyRow };
export type NewApiKey = Prisma.ApiKeyUncheckedCreateInput;

const KEY_PREFIX = "csk_";

function hashKey(raw: string): string {
  return createHash("sha256").update(raw).digest("hex");
}

export class ApiKey {
  static generateRawKey(): string {
    return KEY_PREFIX + randomBytes(32).toString("base64url");
  }

  static async create(name: string): Promise<{ row: ApiKeyRow; rawKey: string }> {
    const prisma = getPrisma();
    const rawKey = ApiKey.generateRawKey();
    const row = await prisma.apiKey.create({
      data: {
        id: createId(),
        key: hashKey(rawKey),
        keyPrefix: rawKey.slice(0, 8),
        name,
      },
    });
    return { row, rawKey };
  }

  static async findByRawKey(rawKey: string): Promise<ApiKeyRow | null> {
    const prisma = getPrisma();
    const row = await prisma.apiKey.findUnique({
      where: { key: hashKey(rawKey) },
    });
    if (row) {
      prisma.apiKey.update({
        where: { id: row.id },
        data: { lastUsedAt: new Date() },
      }).catch(() => {});
    }
    return row;
  }

  static async findById(id: string): Promise<ApiKeyRow | null> {
    const prisma = getPrisma();
    return prisma.apiKey.findUnique({ where: { id } });
  }

  static async delete(id: string): Promise<void> {
    const prisma = getPrisma();
    await prisma.apiKey.delete({ where: { id } });
  }

  static async findMany(): Promise<ApiKeyRow[]> {
    const prisma = getPrisma();
    return prisma.apiKey.findMany({ orderBy: { createdAt: "desc" } });
  }
}

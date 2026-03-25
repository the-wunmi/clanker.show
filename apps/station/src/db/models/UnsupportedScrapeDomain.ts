import type { Prisma, UnsupportedScrapeDomain as UnsupportedScrapeDomainRow } from "../../generated/prisma/client";
import { getPrisma } from "../connection";
import { createId } from "../id";

export type { UnsupportedScrapeDomainRow };
export type NewUnsupportedScrapeDomain = Prisma.UnsupportedScrapeDomainUncheckedCreateInput;

export class UnsupportedScrapeDomain {
  static async isBlockedHost(host: string): Promise<boolean> {
    const prisma = getPrisma();
    const row = await prisma.unsupportedScrapeDomain.findUnique({
      where: { host: host.toLowerCase() },
      select: { id: true },
    });
    return Boolean(row);
  }

  static async markHost(host: string, reason?: string): Promise<void> {
    const prisma = getPrisma();
    const normalisedHost = host.toLowerCase().trim();
    if (!normalisedHost) return;
    await prisma.unsupportedScrapeDomain.upsert({
      where: { host: normalisedHost },
      update: {
        reason: reason ?? null,
        updatedAt: new Date(),
      },
      create: {
        id: createId(),
        host: normalisedHost,
        reason: reason ?? null,
      },
    });
  }
}

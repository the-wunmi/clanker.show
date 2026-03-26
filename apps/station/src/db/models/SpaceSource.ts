import type { SpaceSource as SpaceSourceRow, Prisma } from "../../generated/prisma/client";
import { getPrisma } from "../connection";
import { createId } from "../id";

export type { SpaceSourceRow };
export type NewSpaceSource = Prisma.SpaceSourceUncheckedCreateInput;

export interface SourceInput {
  type?: string;
  query: string;
}

export class SpaceSource {
  static async bulkCreate(spaceId: string, sources: SourceInput[]) {
    if (sources.length === 0) return [];
    const prisma = getPrisma();
    const data = sources.map((s, i) => ({
      id: createId(),
      spaceId,
      type: s.type ?? "firecrawl_search",
      query: s.query,
      sortOrder: i,
    }));
    return prisma.spaceSource.createManyAndReturn({ data });
  }

  static async findMany(opts: Prisma.SpaceSourceFindManyArgs) {
    const prisma = getPrisma();
    return prisma.spaceSource.findMany({
      orderBy: { createdAt: "desc" },
      ...opts,
    });
  }

  static async replaceForSpace(spaceId: string, sources: SourceInput[]) {
    const prisma = getPrisma();
    await prisma.spaceSource.deleteMany({ where: { spaceId } });
    return this.bulkCreate(spaceId, sources);
  }
}

import type { StationSource as StationSourceRow, Prisma } from "../../generated/prisma/client";
import { getPrisma } from "../connection";
import { createId } from "../id";

export type { StationSourceRow };
export type NewStationSource = Prisma.StationSourceUncheckedCreateInput;

export interface SourceInput {
  type?: string;
  query: string;
}

export class StationSource {
  static async bulkCreate(stationId: string, sources: SourceInput[]) {
    if (sources.length === 0) return [];
    const prisma = getPrisma();
    const data = sources.map((s, i) => ({
      id: createId(),
      stationId,
      type: s.type ?? "firecrawl_search",
      query: s.query,
      sortOrder: i,
    }));
    return prisma.stationSource.createManyAndReturn({ data });
  }

  static async findMany(opts: Prisma.StationSourceFindManyArgs) {
    const prisma = getPrisma();
    return prisma.stationSource.findMany({
      orderBy: { createdAt: "desc" },
      ...opts,
    });
  }

  // TODO do in transaction
  static async replaceForStation(stationId: string, sources: SourceInput[]) {
    const prisma = getPrisma();
    await prisma.stationSource.deleteMany({ where: { stationId } });
    return this.bulkCreate(stationId, sources);
  }
}

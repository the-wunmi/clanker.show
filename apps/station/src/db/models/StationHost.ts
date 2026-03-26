import type { StationHost as StationHostRow, Prisma } from "../../generated/prisma/client";
import { getPrisma } from "../connection";
import { createId } from "../id";

export type { StationHostRow };
export type NewStationHost = Prisma.StationHostUncheckedCreateInput;

export interface HostInput {
  name: string;
  personality: string;
  voiceId: string;
  style?: number;
}

export class StationHost {
  static async bulkCreate(stationId: string, hosts: HostInput[]) {
    if (hosts.length === 0) return [];
    const prisma = getPrisma();
    const data = hosts.map((h, i) => ({
      id: createId(),
      stationId,
      name: h.name,
      personality: h.personality,
      voiceId: h.voiceId,
      style: h.style ?? 0.5,
      sortOrder: i,
    }));
    return prisma.stationHost.createManyAndReturn({ data });
  }

  static async findMany(opts: Prisma.StationHostFindManyArgs) {
    const prisma = getPrisma();
    return prisma.stationHost.findMany({
      orderBy: { createdAt: "desc" },
      ...opts,
    });
  }

  static async update(id: string, data: Prisma.StationHostUncheckedUpdateInput) {
    const prisma = getPrisma();
    return prisma.stationHost.update({ where: { id }, data });
  }

  // TODO do in transaction
  static async replaceForStation(stationId: string, hosts: HostInput[]) {
    const prisma = getPrisma();
    await prisma.stationHost.deleteMany({ where: { stationId } });
    return this.bulkCreate(stationId, hosts);
  }
}

import type { SpaceHost as SpaceHostRow, Prisma } from "../../generated/prisma/client";
import { getPrisma } from "../connection";
import { createId } from "../id";

export type { SpaceHostRow };
export type NewSpaceHost = Prisma.SpaceHostUncheckedCreateInput;

export interface HostInput {
  name: string;
  personality: string;
  voiceId: string;
  style?: number;
}

export class SpaceHost {
  static async bulkCreate(spaceId: string, hosts: HostInput[]) {
    if (hosts.length === 0) return [];
    const prisma = getPrisma();
    const data = hosts.map((h, i) => ({
      id: createId(),
      spaceId,
      name: h.name,
      personality: h.personality,
      voiceId: h.voiceId,
      style: h.style ?? 0.5,
      sortOrder: i,
    }));
    return prisma.spaceHost.createManyAndReturn({ data });
  }

  static async findMany(opts: Prisma.SpaceHostFindManyArgs) {
    const prisma = getPrisma();
    return prisma.spaceHost.findMany({
      orderBy: { createdAt: "desc" },
      ...opts,
    });
  }

  static async update(id: string, data: Prisma.SpaceHostUncheckedUpdateInput) {
    const prisma = getPrisma();
    return prisma.spaceHost.update({ where: { id }, data });
  }

  static async replaceForSpace(spaceId: string, hosts: HostInput[]) {
    const prisma = getPrisma();
    await prisma.spaceHost.deleteMany({ where: { spaceId } });
    return this.bulkCreate(spaceId, hosts);
  }
}

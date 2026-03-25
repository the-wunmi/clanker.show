import type { Segment as SegmentRow, Prisma } from "../../generated/prisma/client";
import { getPrisma } from "../connection";
import { createId } from "../id";

export type { SegmentRow };
export type NewSegment = Prisma.SegmentUncheckedCreateInput;

export class Segment {
  static async create(data: Omit<NewSegment, "id">) {
    const prisma = getPrisma();
    return prisma.segment.create({ data: { ...data, id: createId() } });
  }

  static async findMany(opts: Prisma.SegmentFindManyArgs) {
    const prisma = getPrisma();
    return prisma.segment.findMany({
      orderBy: { createdAt: "desc" },
      ...opts,
    });
  }

  static async update(id: string, data: Partial<Omit<NewSegment, "id" | "createdAt">>) {
    const prisma = getPrisma();
    return prisma.segment.update({ where: { id }, data: { ...data } });
  }
}

import type { RundownSegment as RundownSegmentRow, Prisma } from "../../generated/prisma/client";
import { getPrisma } from "../connection";
import { createId } from "../id";

export type { RundownSegmentRow };
export type NewRundownSegment = Prisma.RundownSegmentUncheckedCreateInput;

export interface RundownSegmentInput {
  topic: string;
  angle: string;
  estimatedMinutes: number;
  order: number;
  status: "planned" | "live" | "completed" | "skipped";
}

export class RundownSegment {
  static async bulkCreate(programId: string, segments: RundownSegmentInput[]) {
    if (segments.length === 0) return [];
    const prisma = getPrisma();
    const data = segments.map((s) => ({
      id: createId(),
      programId,
      topic: s.topic,
      angle: s.angle,
      estimatedMinutes: s.estimatedMinutes,
      sortOrder: s.order,
      status: s.status,
    }));
    return prisma.rundownSegment.createManyAndReturn({ data });
  }

  static async findMany(opts: Prisma.RundownSegmentFindManyArgs) {
    const prisma = getPrisma();
    return prisma.rundownSegment.findMany({
      orderBy: { sortOrder: "asc" },
      ...opts,
    });
  }

  // TODO do in transaction
  static async replaceForProgram(programId: string, segments: RundownSegmentInput[]) {
    const prisma = getPrisma();
    await prisma.rundownSegment.deleteMany({ where: { programId } });
    return this.bulkCreate(programId, segments);
  }

  static async update(id: string, data: Partial<Omit<NewRundownSegment, "id" | "createdAt">>) {
    const prisma = getPrisma();
    return prisma.rundownSegment.update({
      where: { id },
      data: { ...data },
    });
  }
}

import type { CallQueueEntry as CallQueueRow, Session as SessionRow, Prisma } from "../../generated/prisma/client";
import { getPrisma } from "../connection";
import { createId } from "../id";

export type { CallQueueRow };
export type NewCallQueue = Prisma.CallQueueEntryUncheckedCreateInput;
export type CallQueueWithSession = CallQueueRow & { session: SessionRow | null };

export class CallQueue {
  static async create(data: Omit<NewCallQueue, "id">) {
    const prisma = getPrisma();
    return prisma.callQueueEntry.create({ data: { ...data, id: createId() } });
  }

  static async update(id: string, data: Partial<Omit<NewCallQueue, "id" | "createdAt">>) {
    const prisma = getPrisma();
    return prisma.callQueueEntry.update({
      where: { id },
      data: { ...data },
    });
  }

  static async findMany(opts: Prisma.CallQueueEntryFindManyArgs) {
    const prisma = getPrisma();
    return prisma.callQueueEntry.findMany({
      orderBy: { createdAt: "desc" },
      ...opts,
    });
  }
}

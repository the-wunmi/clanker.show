import type { EditorialDecision as EditorialDecisionRow, Prisma } from "../../generated/prisma/client";
import { getPrisma } from "../connection";
import { createId } from "../id";

export type { EditorialDecisionRow };
export type NewEditorialDecision = Prisma.EditorialDecisionUncheckedCreateInput;

export class EditorialDecision {
  static async create(data: Omit<NewEditorialDecision, "id">) {
    const prisma = getPrisma();
    return prisma.editorialDecision.create({ data: { ...data, id: createId() } });
  }

  static async findMany(opts: Prisma.EditorialDecisionFindManyArgs) {
    const prisma = getPrisma();
    return prisma.editorialDecision.findMany({
      orderBy: { createdAt: "desc" },
      ...opts,
    });
  }
}

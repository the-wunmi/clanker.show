import type { Program as ProgramRow, Prisma } from "../../generated/prisma/client";
import { getPrisma } from "../connection";
import { createId } from "../id";

export type { ProgramRow };
export type NewProgram = Prisma.ProgramUncheckedCreateInput;

export class Program {
  static async create(data: Omit<NewProgram, "id">) {
    const prisma = getPrisma();
    return prisma.program.create({ data: { ...data, id: createId() } });
  }

  static async findById(id: string) {
    const prisma = getPrisma();
    return prisma.program.findUnique({ where: { id } });
  }

  static async findMany(opts: Prisma.ProgramFindManyArgs) {
    const prisma = getPrisma();
    return prisma.program.findMany({
      orderBy: { createdAt: "desc" },
      ...opts,
    });
  }

  static async update(id: string, data: Partial<Omit<NewProgram, "id" | "createdAt">>) {
    const prisma = getPrisma();
    return prisma.program.update({
      where: { id },
      data: { ...data, updatedAt: new Date() },
    });
  }
}

import type {
  Space as SpaceRow,
  Prisma,
} from "../../generated/prisma/client";
import { getPrisma } from "../connection";
import { createId } from "../id";

export type { SpaceRow };
export type NewSpace = Prisma.SpaceUncheckedCreateInput;

export type SpaceHostRow = Prisma.SpaceHostGetPayload<{}>;
export type SpaceSourceRow = Prisma.SpaceSourceGetPayload<{}>;

export type SpaceWithRelations = SpaceRow & {
  hosts: SpaceHostRow[];
  sources: SpaceSourceRow[];
};

type WithRelations = {
  hosts?: boolean;
  sources?: boolean;
};

type SpacePayload<R extends WithRelations | undefined> = SpaceRow
  & (R extends { hosts: true } ? { hosts: SpaceHostRow[] } : {})
  & (R extends { sources: true } ? { sources: SpaceSourceRow[] } : {});

export class Space {
  static async create(data: Omit<NewSpace, "id">) {
    const prisma = getPrisma();
    return prisma.space.create({ data: { ...data, id: createId() } });
  }

  static async findBySlug<R extends WithRelations | undefined>(
    slug: string,
    relations?: R,
  ): Promise<SpacePayload<R> | null> {
    const prisma = getPrisma();
    return prisma.space.findUnique({
      where: { slug },
      include: relations,
    }) as Promise<SpacePayload<R> | null>;
  }

  static async findMany<R extends WithRelations | undefined>(opts: Prisma.SpaceFindManyArgs): Promise<SpacePayload<R>[]> {
    const prisma = getPrisma();
    return prisma.space.findMany({
      orderBy: { createdAt: "desc" },
      ...opts,
    }) as Promise<SpacePayload<R>[]>;
  }

  static async update(
    id: string,
    data: Partial<Omit<NewSpace, "id" | "createdAt" | "updatedAt">>,
  ) {
    const prisma = getPrisma();
    return prisma.space.update({
      where: { id },
      data: { ...data, updatedAt: new Date() },
    });
  }

  static async delete(slug: string) {
    const prisma = getPrisma();
    return prisma.space.delete({ where: { slug } });
  }
}

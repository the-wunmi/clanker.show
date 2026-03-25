import type {
  Station as StationRow,
  Prisma,
} from "../../generated/prisma/client";
import { getPrisma } from "../connection";
import { createId } from "../id";

export type { StationRow };
export type NewStation = Prisma.StationUncheckedCreateInput;

export type StationHostRow = Prisma.StationHostGetPayload<{}>;
export type StationSourceRow = Prisma.StationSourceGetPayload<{}>;

export type StationWithRelations = StationRow & {
  hosts: StationHostRow[];
  sources: StationSourceRow[];
};

type WithRelations = {
  hosts?: boolean;
  sources?: boolean;
};

type StationPayload<R extends WithRelations | undefined> = StationRow
  & (R extends { hosts: true } ? { hosts: StationHostRow[] } : {})
  & (R extends { sources: true } ? { sources: StationSourceRow[] } : {});

export class Station {
  static async create(data: Omit<NewStation, "id">) {
    const prisma = getPrisma();
    return prisma.station.create({ data: { ...data, id: createId() } });
  }

  static async findBySlug<R extends WithRelations | undefined>(
    slug: string,
    relations?: R,
  ): Promise<StationPayload<R> | null> {
    const prisma = getPrisma();
    return prisma.station.findUnique({
      where: { slug },
      include: relations,
    }) as Promise<StationPayload<R> | null>;
  }

  static async list<R extends WithRelations | undefined>(
    relations?: R,
  ): Promise<StationPayload<R>[]> {
    const prisma = getPrisma();
    return prisma.station.findMany({
      orderBy: { listenerCount: "desc" },
      include: relations,
    }) as Promise<StationPayload<R>[]>;
  }

  static async update(
    slug: string,
    data: Partial<Omit<NewStation, "id" | "createdAt" | "updatedAt">>,
  ) {
    const prisma = getPrisma();
    return prisma.station.update({
      where: { slug },
      data: { ...data, updatedAt: new Date() },
    });
  }

  static async delete(slug: string) {
    const prisma = getPrisma();
    return prisma.station.delete({ where: { slug } });
  }
}

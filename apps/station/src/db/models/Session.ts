import type { Session as SessionRow, Prisma } from "../../generated/prisma/client";
import { getPrisma } from "../connection";
import { createId } from "../id";
import { randomBytes } from "node:crypto";

export type { SessionRow };
export type NewSession = Prisma.SessionUncheckedCreateInput;

export class Session {
  static generateToken(): string {
    return randomBytes(24).toString("base64url");
  }

  static async create(data: Omit<NewSession, "id" | "sessionToken"> & { sessionToken?: string }) {
    const prisma = getPrisma();
    return prisma.session.create({
      data: {
        ...data,
        id: createId(),
        sessionToken: data.sessionToken ?? Session.generateToken(),
      },
    });
  }

  static async findByToken(token: string) {
    const prisma = getPrisma();
    return prisma.session.findUnique({
      where: { sessionToken: token },
    });
  }
}

import type {
  TranscriptLine as TranscriptLineRow,
  Prisma,
} from "../../generated/prisma/client";
import { getPrisma } from "../connection";
import { createId } from "../id";

export type { TranscriptLineRow };
export type NewTranscriptLine = Prisma.TranscriptLineUncheckedCreateInput;

export class TranscriptLine {
  static async bulkCreate(
    segmentId: string,
    lines: Array<{ host: string; text: string; emotion: string }>,
  ): Promise<TranscriptLineRow[]> {
    if (lines.length === 0) return [];
    const prisma = getPrisma();

    const data = lines.map((line, index) => ({
      id: createId(),
      segmentId,
      lineIndex: index,
      host: line.host,
      text: line.text,
      emotion: line.emotion,
    }));

    return prisma.transcriptLine.createManyAndReturn({ data });
  }

  static async findMany(opts: Prisma.TranscriptLineFindManyArgs) {
    const prisma = getPrisma();
    return prisma.transcriptLine.findMany({
      orderBy: { createdAt: "desc" },
      ...opts,
    });
  }

  static async update(
    id: string,
    data: Partial<Omit<NewTranscriptLine, "id" | "createdAt">>,
  ) {
    const prisma = getPrisma();
    return prisma.transcriptLine.update({ where: { id }, data: { ...data } });
  }

  static async updateVerification(
    id: string,
    status: "verified" | "disputed" | "unverifiable" | "error",
    reasoning: string | null,
    sources: string[],
    correctedText?: string | null,
  ) {
    const prisma = getPrisma();
    const data: Prisma.TranscriptLineUpdateInput = {
      factCheckStatus: status,
      factCheckReasoning: reasoning,
      factCheckSources: JSON.stringify(sources),
    };

    if (status === "disputed" && correctedText) {
      const current = await prisma.transcriptLine.findUnique({
        where: { id },
        select: { text: true },
      });
      data.disputedOriginalText = current?.text ?? null;
      data.text = correctedText;
    }

    return prisma.transcriptLine.update({ where: { id }, data });
  }
}

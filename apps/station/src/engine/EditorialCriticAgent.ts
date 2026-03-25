import type { ScriptLine } from "../services/ScriptGenerator";

export class EditorialCriticAgent {
  reviewScript(lines: ScriptLine[], kind: "filler" | "topic"): ScriptLine[] {
    const cleaned = lines
      .map((line) => ({
        ...line,
        text: line.text.trim(),
      }))
      .filter((line) => line.host && line.text.length > 0);

    if (cleaned.length > 0) return cleaned;

    return [
      {
        host: "Host",
        emotion: kind === "filler" ? "neutral" : "serious",
        text: kind === "filler"
          ? "Let us reset and jump back in with a fresh topic."
          : "We are gathering the details and will continue shortly.",
      },
    ];
  }
}

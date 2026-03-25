import type { ScriptLine } from "../services/ScriptGenerator";

export interface ScriptBatch {
  host: string;
  emotion: ScriptLine["emotion"];
  text: string;
  endIndex: number;
}

export class SegmentAudioBatcher {
  constructor(
    private readonly maxChars = 320,
    private readonly maxLines = 3,
  ) {}

  build(lines: ScriptLine[], startIndex: number): ScriptBatch {
    const host = lines[startIndex].host;
    const emotion = lines[startIndex].emotion;
    let batchText = lines[startIndex].text;
    let endIndex = startIndex;
    let charCount = lines[startIndex].text.length;
    let lineCount = 1;

    for (let j = startIndex + 1; j < lines.length; j++) {
      if (lines[j].host !== host) break;
      const nextLength = charCount + 1 + lines[j].text.length;
      if (lineCount >= this.maxLines || nextLength > this.maxChars) {
        break;
      }

      batchText += ` ${lines[j].text}`;
      endIndex = j;
      charCount = nextLength;
      lineCount += 1;
    }

    return { host, emotion, text: batchText, endIndex };
  }
}

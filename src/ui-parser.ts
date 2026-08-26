import { parseAcpxStdoutLine } from "@paperclipai/adapter-utils/acpx-engine/ui";
import type { TranscriptEntry } from "@paperclipai/adapter-utils";

export function parseStdoutLine(line: string, ts: string): TranscriptEntry[] {
  return parseAcpxStdoutLine(line, ts);
}

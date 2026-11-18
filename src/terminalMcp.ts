import type { IBuffer } from "@xterm/xterm";

interface Snapshot {
  id: string;
  created: number;
  lines: string[];
  bufferType: "normal" | "alternate";
  truncated: boolean;
}

/** Short-lived immutable snapshots, so scrolling/clearing cannot shift a cursor. */
export class TerminalMcpReader {
  private snapshots: Snapshot[] = [];

  clear() {
    this.snapshots = [];
  }

  read(buffer: IBuffer, maxLines = 200, cursor?: string | null) {
    if (!Number.isInteger(maxLines) || maxLines < 1 || maxLines > 500)
      throw new Error("maxLines must be from 1 to 500");
    const now = Date.now();
    this.snapshots = this.snapshots.filter(
      (snapshot) => now - snapshot.created < 60_000,
    );
    let snapshot: Snapshot;
    let end: number;
    if (cursor) {
      const [id, row, extra] = cursor.split(":");
      const found = this.snapshots.find((snapshot) => snapshot.id === id);
      end = Number(row);
      if (
        !found ||
        extra !== undefined ||
        !/^\d+$/.test(row ?? "") ||
        !Number.isSafeInteger(end) ||
        end < 1 ||
        end > found.lines.length
      )
        throw new Error(
          "Terminal cursor expired or invalid; read again without a cursor",
        );
      snapshot = found;
    } else {
      let last = buffer.length;
      const cursorEnd = buffer.baseY + buffer.cursorY + 1;
      while (
        last > cursorEnd &&
        !buffer
          .getLine(last - 1)
          ?.translateToString(true)
          .trim()
      )
        last--;
      const first = Math.max(0, last - 2000);
      const lines: string[] = [];
      let length = 0;
      let truncated = first > 0;
      for (let row = last - 1; row >= first; row--) {
        let text = buffer.getLine(row)?.translateToString(true) ?? "";
        if (text.length > 4000) {
          text = Array.from(text).slice(0, 2000).join("") + "…";
          truncated = true;
        }
        if (length + text.length + 1 > 128_000) {
          truncated = true;
          break;
        }
        lines.push(text);
        length += text.length + 1;
      }
      snapshot = {
        id: crypto.randomUUID(),
        created: now,
        lines: lines.reverse(),
        bufferType: buffer.type,
        truncated,
      };
      this.snapshots.push(snapshot);
      this.snapshots = this.snapshots.slice(-2);
      end = snapshot.lines.length;
    }
    let start = end,
      length = 0;
    while (start > 0 && end - start < maxLines) {
      const size = snapshot.lines[start - 1].length + 1;
      if (length + size > 16_000) break;
      length += size;
      start--;
    }
    return {
      output: snapshot.lines.slice(start, end).join("\n"),
      bufferType: snapshot.bufferType,
      snapshotId: snapshot.id,
      capturedAt: new Date(snapshot.created).toISOString(),
      startLine: start,
      endLine: end,
      totalLines: snapshot.lines.length,
      truncated: snapshot.truncated,
      nextCursor: start > 0 ? `${snapshot.id}:${start}` : null,
    };
  }
}

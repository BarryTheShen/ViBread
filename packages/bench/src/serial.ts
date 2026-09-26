import { decodeDeviceLine, type DecodedLine } from "@vibread/core";

/** Incremental NDJSON decoder for Web Serial chunks. */
export class LineDecoder {
  private buffer = "";

  push(chunk: string): DecodedLine[] {
    this.buffer += chunk;
    const decoded: DecodedLine[] = [];
    let offset = 0;

    while (offset < this.buffer.length) {
      let boundary = -1;
      let width = 1;
      for (let index = offset; index < this.buffer.length; index += 1) {
        const code = this.buffer.charCodeAt(index);
        if (code === 10) {
          boundary = index;
          width = 1;
          break;
        }
        if (code === 13) {
          // Hold a terminal CR until the next chunk so a split CRLF is one line.
          if (index === this.buffer.length - 1) break;
          boundary = index;
          width = this.buffer.charCodeAt(index + 1) === 10 ? 2 : 1;
          break;
        }
      }
      if (boundary < 0) break;

      const raw = this.buffer.slice(offset, boundary);
      offset = boundary + width;
      if (raw.trim().length > 0) decoded.push(decodeDeviceLine(raw));
    }

    this.buffer = this.buffer.slice(offset);
    return decoded;
  }
}

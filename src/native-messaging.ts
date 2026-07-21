/**
 * Chrome native-messaging wire format: each message is a 4-byte little-endian
 * length prefix followed by that many bytes of UTF-8 JSON. Chrome speaks this
 * over the native host's stdin/stdout.
 */

/** Frame a value for sending to Chrome. */
export function encodeMessage(msg: unknown): Buffer {
  const json = Buffer.from(JSON.stringify(msg), "utf8");
  const len = Buffer.alloc(4);
  len.writeUInt32LE(json.length, 0);
  return Buffer.concat([len, json]);
}

/**
 * Accumulates incoming stdin chunks and yields whole messages as they complete
 * (chunks may split or batch frames).
 */
export class MessageReader {
  private buf = Buffer.alloc(0);

  push(chunk: Buffer): unknown[] {
    this.buf = Buffer.concat([this.buf, chunk]);
    const out: unknown[] = [];
    while (this.buf.length >= 4) {
      const len = this.buf.readUInt32LE(0);
      if (this.buf.length < 4 + len) break;
      const json = this.buf.subarray(4, 4 + len).toString("utf8");
      this.buf = this.buf.subarray(4 + len);
      try {
        out.push(JSON.parse(json));
      } catch {
        /* skip an unparseable frame rather than wedging the stream */
      }
    }
    return out;
  }
}

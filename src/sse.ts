/**
 * Incremental Server-Sent Events parser. Feed it text as it arrives; it calls
 * `onData` with each complete event's data. Comment lines (the server's
 * `: heartbeat`) and fields other than `data` are ignored.
 */
export class SseParser {
  private buffer = '';
  private dataLines: string[] = [];

  constructor(private readonly onData: (data: string) => void) {}

  push(chunk: string): void {
    this.buffer += chunk;
    let newline: number;
    while ((newline = this.buffer.search(/\r\n|\r|\n/)) !== -1) {
      const line = this.buffer.slice(0, newline);
      const width = this.buffer.startsWith('\r\n', newline) ? 2 : 1;
      // A lone trailing \r may be the first half of \r\n; wait for more input.
      if (width === 1 && this.buffer[newline] === '\r' && newline === this.buffer.length - 1) break;
      this.buffer = this.buffer.slice(newline + width);
      this.line(line);
    }
  }

  private line(line: string): void {
    if (line === '') {
      if (this.dataLines.length > 0) {
        const data = this.dataLines.join('\n');
        this.dataLines = [];
        this.onData(data);
      }
      return;
    }
    if (line.startsWith(':')) return;
    const colon = line.indexOf(':');
    const field = colon === -1 ? line : line.slice(0, colon);
    if (field !== 'data') return;
    let value = colon === -1 ? '' : line.slice(colon + 1);
    if (value.startsWith(' ')) value = value.slice(1);
    this.dataLines.push(value);
  }
}

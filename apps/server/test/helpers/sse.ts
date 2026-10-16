export interface SseMessage {
  id?: string;
  event: string;
  data: unknown;
}

/** Minimal Server-Sent Events client over fetch, for tests (mirrors what a browser EventSource does). */
export class SseClient {
  readonly messages: SseMessage[] = [];
  readonly comments: string[] = [];
  status = 0;
  closed = false;
  private readonly abort = new AbortController();
  private reading: Promise<void> | undefined;

  static async connect(url: string, headers: Record<string, string> = {}): Promise<SseClient> {
    const client = new SseClient();
    const res = await fetch(url, { headers: { accept: 'text/event-stream', ...headers }, signal: client.abort.signal });
    client.status = res.status;
    if (res.ok && res.body) {
      client.reading = client.read(res.body);
    } else {
      client.closed = true;
      await res.body?.cancel();
    }
    return client;
  }

  get jobEvents(): { id: string; type: string; jobId: string; data: Record<string, unknown> }[] {
    return this.messages
      .filter((m) => m.event === 'job')
      .map((m) => m.data as { id: string; type: string; jobId: string; data: Record<string, unknown> });
  }

  /** The id a browser would send as Last-Event-ID on reconnect. */
  get lastEventId(): string | undefined {
    for (let i = this.messages.length - 1; i >= 0; i--) {
      const id = this.messages[i]?.id;
      if (id) return id;
    }
    return undefined;
  }

  async waitFor(predicate: (c: SseClient) => boolean, timeoutMs = 10_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (!predicate(this)) {
      if (Date.now() > deadline) {
        throw new Error(`SSE wait timed out; got ${JSON.stringify(this.messages.map((m) => m.event))}`);
      }
      await new Promise((r) => setTimeout(r, 25));
    }
  }

  async close(): Promise<void> {
    this.abort.abort();
    await this.reading?.catch(() => undefined);
    this.closed = true;
  }

  private async read(body: ReadableStream<Uint8Array>): Promise<void> {
    const decoder = new TextDecoder();
    let buffer = '';
    const reader = body.getReader();
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let sep: number;
        while ((sep = buffer.indexOf('\n\n')) !== -1) {
          const block = buffer.slice(0, sep);
          buffer = buffer.slice(sep + 2);
          this.parse(block);
        }
      }
    } catch (err) {
      if (!(err instanceof Error && err.name === 'AbortError')) throw err;
    } finally {
      this.closed = true;
    }
  }

  private parse(block: string): void {
    let event = 'message';
    let id: string | undefined;
    const data: string[] = [];
    for (const line of block.split('\n')) {
      if (line.startsWith(':')) {
        this.comments.push(line.slice(1).trim());
        continue;
      }
      const idx = line.indexOf(':');
      const field = idx === -1 ? line : line.slice(0, idx);
      const value = idx === -1 ? '' : line.slice(idx + 1).replace(/^ /, '');
      if (field === 'event') event = value;
      else if (field === 'id') id = value;
      else if (field === 'data') data.push(value);
    }
    if (data.length === 0) return; // retry-only or comment-only block
    const raw = data.join('\n');
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      parsed = raw;
    }
    this.messages.push({ event, data: parsed, ...(id ? { id } : {}) });
  }
}

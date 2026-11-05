/**
 * Watches an Anthropic Messages SSE stream as it passes through, without
 * modifying it, and pulls out token usage and the model name.
 */
export class SseUsageTap {
  private buf = '';
  private decoder = new TextDecoder();
  inputTokens = 0;
  outputTokens = 0;
  model: string | undefined;
  stopReason: string | undefined;
  error: string | undefined;

  push(chunk: Uint8Array | string): void {
    this.buf += typeof chunk === 'string' ? chunk : this.decoder.decode(chunk, { stream: true });
    this.buf = this.buf.replace(/\r\n/g, '\n');
    let idx: number;
    while ((idx = this.buf.indexOf('\n\n')) !== -1) {
      const event = this.buf.slice(0, idx);
      this.buf = this.buf.slice(idx + 2);
      this.handle(event);
    }
  }

  end(): void {
    if (this.buf.trim()) this.handle(this.buf);
    this.buf = '';
  }

  private handle(event: string): void {
    const data = event
      .split('\n')
      .filter((l) => l.startsWith('data:'))
      .map((l) => l.slice(5).trimStart())
      .join('\n');
    if (!data || data === '[DONE]') return;
    let j: Record<string, unknown>;
    try {
      j = JSON.parse(data) as Record<string, unknown>;
    } catch {
      return;
    }
    applyUsage(this, j);
  }
}

type UsageSink = { inputTokens: number; outputTokens: number; model?: string; stopReason?: string; error?: string };

function n(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : 0;
}

function usageInput(u: Record<string, unknown>): number {
  return n(u.input_tokens) + n(u.cache_read_input_tokens) + n(u.cache_creation_input_tokens);
}

export function applyUsage(sink: UsageSink, j: Record<string, unknown>): void {
  switch (j.type) {
    case 'message_start': {
      const msg = (j.message ?? {}) as Record<string, unknown>;
      if (typeof msg.model === 'string') sink.model = msg.model;
      const u = (msg.usage ?? {}) as Record<string, unknown>;
      sink.inputTokens = Math.max(sink.inputTokens, usageInput(u));
      sink.outputTokens = Math.max(sink.outputTokens, n(u.output_tokens));
      break;
    }
    case 'message_delta': {
      const u = (j.usage ?? {}) as Record<string, unknown>;
      // output_tokens in message_delta is cumulative.
      if (u.output_tokens !== undefined) sink.outputTokens = n(u.output_tokens);
      const inp = usageInput(u);
      if (inp > 0) sink.inputTokens = Math.max(sink.inputTokens, inp);
      const d = (j.delta ?? {}) as Record<string, unknown>;
      if (typeof d.stop_reason === 'string') sink.stopReason = d.stop_reason;
      break;
    }
    case 'error': {
      const e = (j.error ?? {}) as Record<string, unknown>;
      sink.error = typeof e.message === 'string' ? e.message : 'stream error';
      break;
    }
    case 'message': {
      // Non-streaming response body.
      if (typeof j.model === 'string') sink.model = j.model;
      const u = (j.usage ?? {}) as Record<string, unknown>;
      sink.inputTokens = usageInput(u);
      sink.outputTokens = n(u.output_tokens);
      if (typeof j.stop_reason === 'string') sink.stopReason = j.stop_reason;
      break;
    }
    default:
      break;
  }
}

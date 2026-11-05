/** Thin client for Ollama Cloud's account endpoints (one key, one account). */

export class OllamaApiError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly retryAfterSec?: number,
  ) {
    super(message);
    this.name = 'OllamaApiError';
  }
}

export interface UsageClientOptions {
  baseUrl: string;
  apiKey: string;
  scope?: 'self' | 'team';
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}

export class OllamaUsageClient {
  constructor(private readonly opts: UsageClientOptions) {}

  private async get(pathAndQuery: string): Promise<unknown> {
    const f = this.opts.fetchImpl ?? fetch;
    const url = new URL(pathAndQuery, this.opts.baseUrl).toString();
    const res = await f(url, {
      headers: { Authorization: `Bearer ${this.opts.apiKey}`, Accept: 'application/json', 'User-Agent': 'ollama-guard' },
      signal: AbortSignal.timeout(this.opts.timeoutMs ?? 15_000),
    });
    const text = await res.text();
    if (!res.ok) {
      let msg = text.slice(0, 300);
      try {
        const j = JSON.parse(text) as { error?: string };
        if (j.error) msg = j.error;
      } catch {
        /* keep raw text */
      }
      const ra = Number(res.headers.get('retry-after'));
      throw new OllamaApiError(`${res.status} ${msg}`.trim(), res.status, Number.isFinite(ra) && ra > 0 ? ra : undefined);
    }
    return text ? (JSON.parse(text) as unknown) : {};
  }

  /** Remaining included/purchased credits, or legacy session/weekly limits. */
  balance(): Promise<unknown> {
    return this.get('/api/balance');
  }

  /** Usage history: 7 daily buckets plus today, grouped by model. */
  usage(range: '24h' | '7d' | '30d' = '7d'): Promise<unknown> {
    const q = new URLSearchParams({ range, group_by: 'model' });
    if (this.opts.scope === 'team') q.set('scope', 'team');
    return this.get(`/api/usage?${q.toString()}`);
  }
}

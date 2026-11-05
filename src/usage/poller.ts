import { EventEmitter } from 'node:events';
import { OllamaApiError, OllamaUsageClient } from './client.js';
import { emptySnapshot, normalizeUsage, type UsageSnapshot } from './normalize.js';

export interface PollerEvents {
  update: [snapshot: UsageSnapshot, previous: UsageSnapshot | undefined];
}

/**
 * Polls /api/balance and /api/usage on a fixed cadence (default 60s, as the
 * docs recommend; the endpoints allow 10 requests/minute per user). Honors
 * Retry-After on 429 and never polls faster than every 15s.
 */
export class UsagePoller extends EventEmitter<PollerEvents> {
  private timer: NodeJS.Timeout | undefined;
  private inflight: Promise<UsageSnapshot> | undefined;
  private lastManual = 0;
  snapshot: UsageSnapshot | undefined;

  constructor(
    private client: OllamaUsageClient | undefined,
    private intervalSec: number,
    private scope: 'self' | 'team' = 'self',
  ) {
    super();
  }

  reconfigure(client: OllamaUsageClient | undefined, intervalSec: number, scope: 'self' | 'team'): void {
    this.client = client;
    this.intervalSec = intervalSec;
    this.scope = scope;
    if (this.timer) {
      this.stop();
      this.start();
    }
  }

  start(): void {
    void this.tick();
  }

  stop(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
  }

  /** Manual refresh from the dashboard, throttled to once per 10s. */
  async refresh(): Promise<UsageSnapshot | undefined> {
    if (Date.now() - this.lastManual < 10_000) return this.snapshot;
    this.lastManual = Date.now();
    return this.pollOnce();
  }

  private schedule(sec: number): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => void this.tick(), Math.max(15, sec) * 1000);
    this.timer.unref?.();
  }

  private async tick(): Promise<void> {
    let next = this.intervalSec;
    try {
      await this.pollOnce();
    } catch (err) {
      if (err instanceof OllamaApiError && err.retryAfterSec) next = Math.max(next, err.retryAfterSec);
    }
    this.schedule(next);
  }

  pollOnce(): Promise<UsageSnapshot> {
    if (this.inflight) return this.inflight;
    this.inflight = this.doPoll().finally(() => {
      this.inflight = undefined;
    });
    return this.inflight;
  }

  private async doPoll(): Promise<UsageSnapshot> {
    const prev = this.snapshot;
    if (!this.client) {
      const snap = emptySnapshot('No Ollama API key configured. Run `ollama-guard init`.');
      this.snapshot = snap;
      this.emit('update', snap, prev);
      return snap;
    }
    const [balance, usage] = await Promise.allSettled([this.client.balance(), this.client.usage('7d')]);
    let snap: UsageSnapshot;
    if (balance.status === 'rejected' && usage.status === 'rejected') {
      const err = balance.reason as Error;
      snap = { ...(prev ?? emptySnapshot()), ok: false, error: describe(err), fetchedAt: new Date().toISOString() };
      this.snapshot = snap;
      this.emit('update', snap, prev);
      if (err instanceof OllamaApiError && err.status === 429) throw err;
      return snap;
    }
    snap = normalizeUsage({
      balance: balance.status === 'fulfilled' ? balance.value : undefined,
      usage: usage.status === 'fulfilled' ? usage.value : undefined,
      scope: this.scope,
    });
    if (balance.status === 'rejected') snap.error = `balance: ${describe(balance.reason as Error)}`;
    else if (usage.status === 'rejected') snap.error = `usage: ${describe(usage.reason as Error)}`;
    this.snapshot = snap;
    this.emit('update', snap, prev);
    return snap;
  }
}

function describe(err: Error): string {
  if (err instanceof OllamaApiError) {
    if (err.status === 401 || err.status === 403) return 'Ollama rejected the API key (401). Check it with `ollama-guard doctor`.';
    if (err.status === 429) return `Usage API rate limited; retrying in ${err.retryAfterSec ?? 60}s.`;
    return `Ollama API error: ${err.message}`;
  }
  if (err.name === 'TimeoutError') return 'Timed out reaching ollama.com.';
  return `Could not reach ollama.com: ${err.message}`;
}

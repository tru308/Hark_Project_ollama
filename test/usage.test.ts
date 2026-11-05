import { describe, expect, it, vi } from 'vitest';
import { normalizeUsage } from '../src/usage/normalize.js';
import { OllamaUsageClient } from '../src/usage/client.js';
import { UsagePoller } from '../src/usage/poller.js';

describe('normalizeUsage', () => {
  it('reads current-plan balance as a monthly window', () => {
    const s = normalizeUsage({
      balance: {
        included: { balance_usd: 72.5, allowance_usd: 100, period: { from: '2026-09-15T09:30:00Z', until: '2026-10-15T09:30:00Z' } },
        purchased: { balance_usd: 25 },
      },
    });
    expect(s.windows).toEqual([{ id: 'monthly', label: 'Monthly credits', used: 0.275, resetsAt: '2026-10-15T09:30:00Z' }]);
    expect(s.headline?.id).toBe('monthly');
    expect(s.purchasedUsd).toBe(25);
    expect(s.includedBalanceUsd).toBe(72.5);
  });

  it('reads legacy session/weekly remaining_percent', () => {
    const s = normalizeUsage({
      balance: {
        included: {
          session: { remaining_percent: 75, resets_at: '2026-10-01T07:00:00Z' },
          weekly: { remaining_percent: 40, resets_at: '2026-10-05T00:00:00Z' },
        },
        purchased: { balance_usd: 0 },
      },
    });
    expect(s.windows.map((w) => [w.id, w.used])).toEqual([
      ['session', 0.25],
      ['weekly', 0.6],
    ]);
    expect(s.headline?.id).toBe('weekly');
  });

  it('accepts a `limits` object with 0..1 usage fractions', () => {
    const s = normalizeUsage({
      usage: { limits: { session: { usage: 0.63, resets_at: '2026-11-05T18:00:00Z' }, weekly: { usage: 0.2 } } },
    });
    expect(s.windows.map((w) => [w.id, w.used])).toEqual([
      ['session', 0.63],
      ['weekly', 0.2],
    ]);
    expect(s.headline).toMatchObject({ id: 'session', resetsAt: '2026-11-05T18:00:00Z' });
  });

  it('prefers /api/balance over the limits object when both exist', () => {
    const s = normalizeUsage({
      balance: { included: { session: { remaining_percent: 10 } } },
      usage: { limits: { session: { usage: 0.5 } } },
    });
    expect(s.windows[0]!.used).toBeCloseTo(0.9);
  });

  it('extracts history totals, today and per-model rates', () => {
    const s = normalizeUsage({
      usage: {
        range: '7d',
        granularity: 'day',
        totals: {
          request_count: 16,
          usage_usd: 0.0268,
          input_tokens: 116000,
          cached_input_tokens: 60000,
          output_tokens: 15000,
          groups: [
            {
              model: 'glm-5.3-flash',
              request_count: 12,
              usage_usd: 0.0132,
              input_tokens: 96000,
              cached_input_tokens: 60000,
              output_tokens: 12000,
            },
          ],
        },
        buckets: [
          { from: 'a', until: 'b', request_count: 8, usage_usd: 0.0166, input_tokens: 52000, cached_input_tokens: 0, output_tokens: 7000 },
          {
            from: 'b',
            until: 'c',
            partial: true,
            request_count: 3,
            usage_usd: 0.003,
            input_tokens: 18000,
            cached_input_tokens: 6000,
            output_tokens: 2400,
          },
        ],
      },
    });
    expect(s.range).toMatchObject({ range: '7d', requests: 16, usd: 0.0268 });
    expect(s.today).toMatchObject({ requests: 3, inputTokens: 18000 });
    expect(s.ratePerToken!['glm-5.3-flash']).toBeCloseTo(0.0132 / 108000);
    expect(s.windows).toEqual([]);
  });
});

describe('OllamaUsageClient', () => {
  it('sends the bearer key and scope', async () => {
    const f = vi.fn(async () => new Response('{}', { status: 200 }));
    const c = new OllamaUsageClient({ baseUrl: 'https://ollama.com', apiKey: 'K', scope: 'team', fetchImpl: f as unknown as typeof fetch });
    await c.usage('7d');
    const [url, init] = f.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://ollama.com/api/usage?range=7d&group_by=model&scope=team');
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer K');
  });

  it('surfaces Retry-After on 429', async () => {
    const f = vi.fn(async () => new Response('{"error":"slow down"}', { status: 429, headers: { 'retry-after': '30' } }));
    const c = new OllamaUsageClient({ baseUrl: 'https://ollama.com', apiKey: 'K', fetchImpl: f as unknown as typeof fetch });
    await expect(c.balance()).rejects.toMatchObject({ status: 429, retryAfterSec: 30 });
  });
});

describe('UsagePoller', () => {
  it('emits a normalized snapshot and keeps the last good windows on error', async () => {
    let fail = false;
    const f = vi.fn(async (url: string) => {
      if (fail) return new Response('{"error":"down"}', { status: 500 });
      if (url.includes('/api/balance'))
        return new Response(JSON.stringify({ included: { session: { remaining_percent: 37, resets_at: '2026-11-05T18:00:00Z' } } }));
      return new Response(JSON.stringify({ range: '7d', granularity: 'day', totals: {}, buckets: [] }));
    });
    const client = new OllamaUsageClient({ baseUrl: 'https://ollama.com', apiKey: 'K', fetchImpl: f as unknown as typeof fetch });
    const poller = new UsagePoller(client, 60);
    const seen: number[] = [];
    poller.on('update', (s) => seen.push(s.windows[0]?.used ?? -1));
    await poller.pollOnce();
    expect(seen[0]).toBeCloseTo(0.63);
    fail = true;
    const s = await poller.pollOnce();
    expect(s.ok).toBe(false);
    expect(s.windows[0]!.used).toBeCloseTo(0.63);
  });

  it('reports a missing key instead of calling the API', async () => {
    const poller = new UsagePoller(undefined, 60);
    const s = await poller.pollOnce();
    expect(s.error).toMatch(/ollama-guard init/);
  });
});

import { afterEach, describe, expect, it } from 'vitest';
import { defaultConfig, mergeConfig } from '../src/config/schema.js';
import { planAttempts, estimateCost, PRIMARY_NAME } from '../src/proxy/plan.js';
import { isLimitError } from '../src/proxy/limits.js';
import { mockUpstream, postMessages, replyJson, replySse, sseMessage, startGuard, type Harness, type MockUpstream } from './helpers.js';

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
  while (cleanup.length) await cleanup.pop()!();
});
const track = <T extends Harness | MockUpstream>(x: T): T => {
  cleanup.push(() => x.close());
  return x;
};

const limitBody = { error: 'you have reached your session usage limit, please wait or upgrade to continue' };

describe('planAttempts', () => {
  const cfg = mergeConfig(defaultConfig(), {
    models: { map: { 'claude-*': 'glm-5.3' } },
    fallback: {
      enabled: true,
      chain: [
        { name: 'local', type: 'ollama-local', defaultModel: 'qwen3-coder' },
        { name: 'openrouter', type: 'openrouter', defaultModel: 'anthropic/claude-sonnet-4.5' },
      ],
    },
    downgrade: { enabled: true, thresholdPercent: 90, map: { 'glm-5.3': 'glm-5.3-flash' } },
  });
  const secrets = { ollamaApiKey: 'ok', providers: { openrouter: 'or-key' } };

  it('tries Ollama Cloud first, then the chain in order', () => {
    const plan = planAttempts('claude-sonnet-4-5', cfg, secrets, { circuitOpen: false, headlineUsed: 0.2 });
    expect(plan.attempts.map((a) => `${a.name}:${a.model}`)).toEqual([
      `${PRIMARY_NAME}:glm-5.3`,
      'local:qwen3-coder',
      'openrouter:anthropic/claude-sonnet-4.5',
    ]);
    expect(plan.attempts[0]!.auth.authorization).toBe('Bearer ok');
    expect(plan.attempts[1]!.auth['x-api-key']).toBe('ollama');
    expect(plan.attempts[2]!.auth.authorization).toBe('Bearer or-key');
  });

  it('downgrades the primary model above the threshold', () => {
    const plan = planAttempts('claude-sonnet-4-5', cfg, secrets, { circuitOpen: false, headlineUsed: 0.93 });
    expect(plan.attempts[0]).toMatchObject({ model: 'glm-5.3-flash', downgraded: true });
  });

  it('does not downgrade below the threshold', () => {
    const plan = planAttempts('claude-sonnet-4-5', cfg, secrets, { circuitOpen: false, headlineUsed: 0.89 });
    expect(plan.attempts[0]).toMatchObject({ model: 'glm-5.3', downgraded: false });
  });

  it('skips straight to the chain while the circuit is open, keeping Ollama as last resort', () => {
    const plan = planAttempts('claude-sonnet-4-5', cfg, secrets, { circuitOpen: true });
    expect(plan.attempts.map((a) => a.name)).toEqual(['local', 'openrouter', PRIMARY_NAME]);
    expect(plan.primarySkipped).toBeTruthy();
  });

  it('only uses Ollama Cloud when fallback is disabled', () => {
    const off = mergeConfig(cfg, { fallback: { enabled: false } });
    expect(planAttempts('x', off, secrets, { circuitOpen: true }).attempts.map((a) => a.name)).toEqual([PRIMARY_NAME]);
  });

  it('never contains more than one Ollama Cloud target', () => {
    const plan = planAttempts('claude-sonnet-4-5', cfg, secrets, { circuitOpen: false });
    expect(plan.attempts.filter((a) => a.kind === 'primary')).toHaveLength(1);
  });
});

describe('isLimitError', () => {
  it('treats configured statuses as limits', () => {
    expect(isLimitError({ status: 429, body: '', triggerStatuses: [429, 402] })).toBe(true);
    expect(isLimitError({ status: 402, body: '', triggerStatuses: [429, 402] })).toBe(true);
  });
  it('recognises quota messages on other statuses', () => {
    expect(isLimitError({ status: 403, body: '{"error":"weekly usage limit reached"}', triggerStatuses: [429] })).toBe(true);
  });
  it('does not treat ordinary errors as limits', () => {
    expect(isLimitError({ status: 400, body: '{"error":"invalid model"}', triggerStatuses: [429, 402] })).toBe(false);
    expect(isLimitError({ status: 500, body: 'boom', triggerStatuses: [429, 402] })).toBe(false);
  });
});

describe('estimateCost', () => {
  it('uses explicit pricing, provider-scoped first', () => {
    const pricing = { 'openrouter::anthropic/*': { inputPerMTok: 3, outputPerMTok: 15 }, 'glm-*': { inputPerMTok: 1, outputPerMTok: 2 } };
    expect(estimateCost('openrouter', 'anthropic/claude-sonnet-4.5', 1_000_000, 100_000, pricing)).toBeCloseTo(4.5);
    expect(estimateCost(PRIMARY_NAME, 'glm-5.3', 1_000_000, 1_000_000, pricing)).toBeCloseTo(3);
  });
  it("falls back to Ollama's own per-model rate", () => {
    expect(estimateCost(PRIMARY_NAME, 'glm-5.3', 1000, 1000, {}, { 'glm-5.3': 0.000001 })).toBeCloseTo(0.002);
  });
  it('is zero for local models without pricing', () => {
    expect(estimateCost('local', 'qwen3-coder', 1000, 1000, {})).toBe(0);
  });
});

describe('transparent fallback', () => {
  it('retries on the fallback when Ollama returns 429, streaming the fallback answer', async () => {
    const primary = track(await mockUpstream((_req, res) => replyJson(res, 429, limitBody, { 'retry-after': '120' })));
    const sse = sseMessage('qwen3-coder', 'from local', 20, 4);
    const local = track(await mockUpstream((_req, res) => replySse(res, sse)));
    const g = track(
      await startGuard({
        ollama: { baseUrl: primary.url },
        fallback: { enabled: true, chain: [{ name: 'local', type: 'ollama-local', baseUrl: local.url, defaultModel: 'qwen3-coder' }] },
      }),
    );

    const res = await postMessages(g.url, { model: 'glm-5.3', stream: true, max_tokens: 10, messages: [{ role: 'user', content: 'hi' }] });
    expect(res.status).toBe(200);
    expect(res.headers.get('x-ollama-guard-provider')).toBe('local');
    expect(await res.text()).toBe(sse);
    expect(JSON.parse(local.calls[0]!.body).model).toBe('qwen3-coder');
    expect(local.calls[0]!.headers.authorization).toBeUndefined(); // the Ollama key never leaks to other providers

    const status = g.rt.status();
    expect(status.fallback.active).toBe(true);
    expect(status.fallback.provider).toBe('local');
    await new Promise((r) => setTimeout(r, 20));
    expect(g.rt.logs.latest(1)[0]).toMatchObject({ provider: 'local', fallback: expect.stringContaining('429') });

    // While the circuit is open, the next request skips Ollama entirely.
    await (await postMessages(g.url, { model: 'glm-5.3', max_tokens: 10, messages: [] })).text();
    expect(primary.calls.length).toBe(1);
    expect(local.calls.length).toBe(2);
  });

  it('falls back on 402 (out of credits)', async () => {
    const primary = track(await mockUpstream((_req, res) => replyJson(res, 402, { error: 'payment required' })));
    const alt = track(
      await mockUpstream((_req, res) => replyJson(res, 200, { type: 'message', usage: { input_tokens: 1, output_tokens: 1 } })),
    );
    const g = track(
      await startGuard(
        {
          ollama: { baseUrl: primary.url },
          fallback: { enabled: true, chain: [{ name: 'openrouter', type: 'openrouter', baseUrl: alt.url, defaultModel: 'x/y' }] },
        },
        { ollamaApiKey: 'k', providers: { openrouter: 'or-key' } },
      ),
    );
    const res = await postMessages(g.url, { model: 'glm-5.3', messages: [] });
    expect(res.status).toBe(200);
    expect(alt.calls[0]!.headers.authorization).toBe('Bearer or-key');
  });

  it('does not fall back on a normal request error', async () => {
    const primary = track(await mockUpstream((_req, res) => replyJson(res, 400, { error: 'model "nope" not found' })));
    const local = track(await mockUpstream((_req, res) => replyJson(res, 200, {})));
    const g = track(
      await startGuard({
        ollama: { baseUrl: primary.url },
        fallback: { enabled: true, chain: [{ name: 'local', type: 'ollama-local', baseUrl: local.url }] },
      }),
    );
    const res = await postMessages(g.url, { model: 'nope', messages: [] });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { type: string; error: { type: string; message: string } };
    expect(body).toMatchObject({ type: 'error', error: { type: 'invalid_request_error' } });
    expect(local.calls.length).toBe(0);
  });

  it('relays the limit error in Anthropic format when fallback is off', async () => {
    const primary = track(await mockUpstream((_req, res) => replyJson(res, 429, limitBody, { 'retry-after': '60' })));
    const g = track(await startGuard({ ollama: { baseUrl: primary.url } }));
    const res = await postMessages(g.url, { model: 'glm-5.3', messages: [] });
    expect(res.status).toBe(429);
    expect(res.headers.get('retry-after')).toBe('60');
    expect(await res.json()).toMatchObject({ type: 'error', error: { type: 'rate_limit_error', message: limitBody.error } });
    expect(g.rt.status().fallback.active).toBe(false);
  });

  it('moves past a broken fallback to the next one', async () => {
    const primary = track(await mockUpstream((_req, res) => replyJson(res, 429, limitBody)));
    const broken = track(await mockUpstream((_req, res) => replyJson(res, 500, { error: 'crashed' })));
    const good = track(await mockUpstream((_req, res) => replyJson(res, 200, { type: 'message', usage: {} })));
    const g = track(
      await startGuard({
        ollama: { baseUrl: primary.url },
        fallback: {
          enabled: true,
          chain: [
            { name: 'local', type: 'ollama-local', baseUrl: broken.url },
            { name: 'backup', type: 'anthropic-compatible', baseUrl: good.url, authStyle: 'none' },
          ],
        },
      }),
    );
    const res = await postMessages(g.url, { model: 'glm-5.3', messages: [] });
    expect(res.status).toBe(200);
    expect(res.headers.get('x-ollama-guard-provider')).toBe('backup');
  });

  it('fails over on network errors only when onNetworkError is set', async () => {
    const local = track(await mockUpstream((_req, res) => replyJson(res, 200, { type: 'message', usage: {} })));
    const dead = 'http://127.0.0.1:9'; // discard port: connection refused
    const chain = [{ name: 'local', type: 'ollama-local', baseUrl: local.url }];
    const off = track(await startGuard({ ollama: { baseUrl: dead }, fallback: { enabled: true, chain } }));
    expect((await postMessages(off.url, { model: 'm', messages: [] })).status).toBe(502);
    const on = track(await startGuard({ ollama: { baseUrl: dead }, fallback: { enabled: true, onNetworkError: true, chain } }));
    expect((await postMessages(on.url, { model: 'm', messages: [] })).status).toBe(200);
  });

  it('applies the pre-emptive downgrade when usage is high', async () => {
    const primary = track(await mockUpstream((_req, res) => replyJson(res, 200, { type: 'message', usage: {} })));
    const g = track(
      await startGuard({
        ollama: { baseUrl: primary.url },
        downgrade: { enabled: true, thresholdPercent: 80, map: { 'glm-5.3': 'glm-5.3-flash' } },
      }),
    );
    g.rt.poller.snapshot = {
      fetchedAt: new Date().toISOString(),
      ok: true,
      windows: [{ id: 'session', label: 'Session', used: 0.85 }],
      headline: { id: 'session', label: 'Session', used: 0.85 },
    };
    await (await postMessages(g.url, { model: 'glm-5.3', messages: [] })).text();
    expect(JSON.parse(primary.calls[0]!.body).model).toBe('glm-5.3-flash');
    expect(g.rt.logs.latest(1)[0]!.downgraded).toBe(true);
  });

  it('closes the circuit and returns to Ollama on manual reset', async () => {
    let limited = true;
    const primary = track(
      await mockUpstream((_req, res) => (limited ? replyJson(res, 429, limitBody) : replyJson(res, 200, { type: 'message', usage: {} }))),
    );
    const local = track(await mockUpstream((_req, res) => replyJson(res, 200, { type: 'message', usage: {} })));
    const g = track(
      await startGuard({
        ollama: { baseUrl: primary.url },
        fallback: { enabled: true, chain: [{ name: 'local', type: 'ollama-local', baseUrl: local.url }] },
      }),
    );
    await (await postMessages(g.url, { model: 'm', messages: [] })).text();
    expect(g.rt.status().fallback.active).toBe(true);
    limited = false;
    await fetch(`${g.url}/api/guard/fallback/reset`, { method: 'POST', headers: { 'x-ollama-guard': '1' } });
    expect(g.rt.status().fallback.active).toBe(false);
    const res = await postMessages(g.url, { model: 'm', messages: [] });
    expect(res.headers.get('x-ollama-guard-provider')).toBe('ollama-cloud');
  });
});

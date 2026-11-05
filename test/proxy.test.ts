import { afterEach, describe, expect, it } from 'vitest';
import { mockUpstream, postMessages, replyJson, replySse, sseMessage, startGuard, type Harness, type MockUpstream } from './helpers.js';

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
  while (cleanup.length) await cleanup.pop()!();
});
const track = <T extends Harness | MockUpstream>(x: T): T => {
  cleanup.push(() => x.close());
  return x;
};

describe('proxy routing', () => {
  it('forwards /v1/messages to Ollama Cloud with the real key and mapped model', async () => {
    const up = track(
      await mockUpstream((_req, res) =>
        replyJson(res, 200, {
          type: 'message',
          model: 'glm-5.3',
          content: [{ type: 'text', text: 'hi' }],
          usage: { input_tokens: 10, output_tokens: 3 },
        }),
      ),
    );
    const g = track(await startGuard({ ollama: { baseUrl: up.url }, models: { map: { 'claude-*': 'glm-5.3' } } }));

    const res = await postMessages(g.url, { model: 'claude-sonnet-4-5', max_tokens: 50, messages: [{ role: 'user', content: 'hello' }] });
    expect(res.status).toBe(200);
    expect(res.headers.get('x-ollama-guard-provider')).toBe('ollama-cloud');
    const body = (await res.json()) as { content: Array<{ text: string }> };
    expect(body.content[0]!.text).toBe('hi');

    const call = up.calls[0]!;
    expect(call.url).toBe('/v1/messages');
    expect(call.headers.authorization).toBe('Bearer sk-test-ollama');
    expect(call.headers['anthropic-version']).toBe('2023-06-01');
    expect(JSON.parse(call.body).model).toBe('glm-5.3');

    const [log] = g.rt.logs.latest(1);
    expect(log).toMatchObject({
      provider: 'ollama-cloud',
      model: 'glm-5.3',
      requestedModel: 'claude-sonnet-4-5',
      inputTokens: 10,
      outputTokens: 3,
      status: 200,
    });
  });

  it('streams SSE through unchanged and records usage', async () => {
    const sse = sseMessage('glm-5.3', 'Hello world', 42, 7);
    const up = track(await mockUpstream((_req, res) => replySse(res, sse)));
    const g = track(await startGuard({ ollama: { baseUrl: up.url } }));
    const res = await postMessages(g.url, { model: 'glm-5.3', stream: true, max_tokens: 50, messages: [{ role: 'user', content: 'hi' }] });
    expect(res.headers.get('content-type')).toContain('text/event-stream');
    expect(await res.text()).toBe(sse);
    await new Promise((r) => setTimeout(r, 20));
    const [log] = g.rt.logs.latest(1);
    expect(log).toMatchObject({ stream: true, inputTokens: 42, outputTokens: 7 });
  });

  it('passes tool definitions and tool_result blocks through intact', async () => {
    const up = track(
      await mockUpstream((_req, res) =>
        replyJson(res, 200, {
          type: 'message',
          content: [{ type: 'tool_use', id: 't1', name: 'get_weather', input: { city: 'Anand' } }],
          stop_reason: 'tool_use',
          usage: { input_tokens: 1, output_tokens: 1 },
        }),
      ),
    );
    const g = track(await startGuard({ ollama: { baseUrl: up.url } }));
    const tools = [
      { name: 'get_weather', description: 'Weather', input_schema: { type: 'object', properties: { city: { type: 'string' } } } },
    ];
    const messages = [
      { role: 'user', content: 'weather?' },
      { role: 'assistant', content: [{ type: 'tool_use', id: 't0', name: 'get_weather', input: { city: 'Pune' } }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't0', content: '31°C' }] },
    ];
    const res = await postMessages(g.url, { model: 'glm-5.3', max_tokens: 50, tools, messages });
    const out = (await res.json()) as { stop_reason: string };
    expect(out.stop_reason).toBe('tool_use');
    const sent = JSON.parse(up.calls[0]!.body);
    expect(sent.tools).toEqual(tools);
    expect(sent.messages).toEqual(messages);
  });

  it('answers count_tokens locally (Ollama does not implement it)', async () => {
    const up = track(await mockUpstream((_req, res) => replyJson(res, 404, { error: 'not found' })));
    const g = track(await startGuard({ ollama: { baseUrl: up.url } }));
    const res = await fetch(`${g.url}/v1/messages/count_tokens`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'x', messages: [{ role: 'user', content: 'a'.repeat(400) }] }),
    });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { input_tokens: number }).input_tokens).toBeGreaterThan(90);
    expect(up.calls.length).toBe(0);
  });

  it('passes other paths through to Ollama Cloud', async () => {
    const up = track(await mockUpstream((_req, res) => replyJson(res, 200, { data: [{ id: 'glm-5.3' }] })));
    const g = track(await startGuard({ ollama: { baseUrl: up.url } }));
    const res = await fetch(`${g.url}/v1/models`);
    expect(res.status).toBe(200);
    expect(up.calls[0]!.url).toBe('/v1/models');
    expect(up.calls[0]!.headers.authorization).toBe('Bearer sk-test-ollama');
  });

  it("detects the project from Claude Code's system prompt", async () => {
    const up = track(
      await mockUpstream((_req, res) => replyJson(res, 200, { type: 'message', usage: { input_tokens: 1, output_tokens: 1 } })),
    );
    const g = track(await startGuard({ ollama: { baseUrl: up.url } }));
    await postMessages(g.url, {
      model: 'm',
      max_tokens: 5,
      system: [{ type: 'text', text: 'You are Claude Code.\nWorking directory: C:\\Users\\trushar\\code\\corpverse\n' }],
      messages: [],
    });
    expect(g.rt.logs.latest(1)[0]!.project).toBe('corpverse');
  });

  it('serves the dashboard and status API', async () => {
    const g = track(await startGuard({}));
    const html = await (await fetch(`${g.url}/dashboard`)).text();
    expect(html).toContain('<title>Ollama Guard</title>');
    const status = (await (await fetch(`${g.url}/api/guard/status`)).json()) as { account: { keyConfigured: boolean } };
    expect(status.account.keyConfigured).toBe(true);
    const cfg = (await (await fetch(`${g.url}/api/guard/config`)).json()) as { secrets: { ollamaApiKey: string } };
    expect(cfg.secrets.ollamaApiKey).not.toContain('sk-test-ollama');
  });
});

describe('local security', () => {
  it('rejects cross-origin browser requests', async () => {
    const g = track(await startGuard({}));
    const res = await fetch(`${g.url}/v1/messages`, {
      method: 'POST',
      headers: { origin: 'https://evil.example', 'content-type': 'text/plain' },
      body: '{}',
    });
    expect(res.status).toBe(403);
  });

  it('rejects unexpected Host headers (DNS rebinding)', async () => {
    const g = track(await startGuard({}));
    const http = await import('node:http');
    const port = new URL(g.url).port;
    const status = await new Promise<number>((resolve) => {
      http.get({ host: '127.0.0.1', port, path: '/api/guard/status', headers: { host: 'attacker.example' } }, (r) =>
        resolve(r.statusCode ?? 0),
      );
    });
    expect(status).toBe(421);
  });

  it('requires the custom header for mutating dashboard calls', async () => {
    const g = track(await startGuard({}));
    const res = await fetch(`${g.url}/api/guard/fallback/reset`, { method: 'POST' });
    expect(res.status).toBe(403);
  });

  it('enforces the proxy token when requireToken is on', async () => {
    const up = track(await mockUpstream((_req, res) => replyJson(res, 200, { type: 'message', usage: {} })));
    const g = track(
      await startGuard({ ollama: { baseUrl: up.url }, server: { requireToken: true } }, { ollamaApiKey: 'k', proxyToken: 'og_secret' }),
    );
    expect((await postMessages(g.url, { model: 'm', messages: [] })).status).toBe(401);
    expect((await postMessages(g.url, { model: 'm', messages: [] }, { authorization: 'Bearer og_secret' })).status).toBe(200);
  });

  it('rejects config that would add a second Ollama Cloud account as fallback', async () => {
    const g = track(await startGuard({}));
    const res = await fetch(`${g.url}/api/guard/config`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json', 'x-ollama-guard': '1' },
      body: JSON.stringify({
        fallback: { enabled: true, chain: [{ name: 'alt', type: 'anthropic-compatible', baseUrl: 'https://ollama.com' }] },
      }),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { problems: string[] };
    expect(body.problems.join(' ')).toMatch(/one Ollama Cloud account/);
  });
});

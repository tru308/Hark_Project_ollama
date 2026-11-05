import fs from 'node:fs';
import http, { type IncomingMessage, type ServerResponse } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { defaultConfig, mergeConfig, type GuardConfig, type Secrets } from '../src/config/schema.js';
import { GuardRuntime } from '../src/runtime.js';
import { createGuardServer } from '../src/server.js';

export interface Recorded {
  method: string;
  url: string;
  headers: IncomingMessage['headers'];
  body: string;
}

export interface MockUpstream {
  url: string;
  calls: Recorded[];
  close(): Promise<void>;
}

/** Spin up a fake Anthropic-compatible upstream on a random port. */
export async function mockUpstream(handler: (req: Recorded, res: ServerResponse) => void | Promise<void>): Promise<MockUpstream> {
  const calls: Recorded[] = [];
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      const rec = { method: req.method ?? '', url: req.url ?? '', headers: req.headers, body: Buffer.concat(chunks).toString('utf8') };
      calls.push(rec);
      void handler(rec, res);
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    calls,
    close: () => new Promise<void>((r) => server.close(() => r())),
  };
}

export function sseMessage(model: string, text: string, input = 12, output = 5): string {
  const ev = (type: string, data: unknown) => `event: ${type}\ndata: ${JSON.stringify(data)}\n\n`;
  return (
    ev('message_start', {
      type: 'message_start',
      message: { id: 'msg_1', type: 'message', role: 'assistant', model, content: [], usage: { input_tokens: input, output_tokens: 1 } },
    }) +
    ev('content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }) +
    ev('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } }) +
    ev('content_block_stop', { type: 'content_block_stop', index: 0 }) +
    ev('message_delta', { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: output } }) +
    ev('message_stop', { type: 'message_stop' })
  );
}

export function replySse(res: ServerResponse, body: string): void {
  res.writeHead(200, { 'content-type': 'text/event-stream' });
  // Send in two pieces to exercise chunk boundaries.
  const mid = Math.floor(body.length / 2);
  res.write(body.slice(0, mid));
  setTimeout(() => res.end(body.slice(mid)), 5);
}

export function replyJson(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  res.writeHead(status, { 'content-type': 'application/json', ...headers });
  res.end(JSON.stringify(body));
}

export interface Harness {
  url: string;
  rt: GuardRuntime;
  close(): Promise<void>;
}

export async function startGuard(overrides: unknown, secrets: Secrets = { ollamaApiKey: 'sk-test-ollama' }): Promise<Harness> {
  const base = mergeConfig(defaultConfig(), { alerts: { desktop: false } });
  const cfg: GuardConfig = mergeConfig(base, overrides);
  const logsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'og-logs-'));
  const rt = new GuardRuntime(cfg, secrets, { logsDir, persist: false });
  rt.logs.load();
  const server = createGuardServer(rt);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address() as AddressInfo;
  rt.config.server.port = port;
  return {
    url: `http://127.0.0.1:${port}`,
    rt,
    close: () =>
      new Promise<void>((r) => {
        server.closeAllConnections?.();
        server.close(() => r());
      }),
  };
}

export async function postMessages(url: string, body: unknown, headers: Record<string, string> = {}): Promise<Response> {
  return fetch(`${url}/v1/messages`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'anthropic-version': '2023-06-01', authorization: 'Bearer ollama-guard', ...headers },
    body: JSON.stringify(body),
  });
}

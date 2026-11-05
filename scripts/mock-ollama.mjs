#!/usr/bin/env node
// A tiny fake of Ollama Cloud for local development and demos. No real key needed.
//
//   node scripts/mock-ollama.mjs [port]            (default 11500)
//
// It implements /api/balance (legacy session/weekly shape), /api/usage, /api/tags
// and an Anthropic-compatible /v1/messages (streaming and not). Every request
// adds ~4% session usage; at 100% it answers 429 like a real limit.
// Point the guard at it with:  "ollama": { "baseUrl": "http://127.0.0.1:11500" }
import http from 'node:http';

const port = Number(process.argv[2] ?? 11500);
let session = 0.58;
let weekly = 0.31;
const sessionResetAt = new Date(Date.now() + 2 * 3600_000 + 10 * 60_000).toISOString();
const sessionReset = () => sessionResetAt;
const weeklyReset = new Date(Date.now() + 3 * 86400_000).toISOString();

const json = (res, status, body, headers = {}) => {
  res.writeHead(status, { 'content-type': 'application/json', ...headers });
  res.end(JSON.stringify(body));
};

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://localhost:${port}`);
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', () => {
    if (url.pathname === '/api/balance') {
      return json(res, 200, {
        included: {
          session: { remaining_percent: Math.max(0, Math.round((1 - session) * 100)), resets_at: sessionReset() },
          weekly: { remaining_percent: Math.max(0, Math.round((1 - weekly) * 100)), resets_at: weeklyReset },
        },
        purchased: { balance_usd: 0 },
      });
    }
    if (url.pathname === '/api/usage') {
      return json(res, 200, {
        range: '7d',
        scope: 'self',
        granularity: 'day',
        totals: { request_count: 0, usage_usd: 0, input_tokens: 0, cached_input_tokens: 0, output_tokens: 0, groups: [] },
        buckets: [],
      });
    }
    if (url.pathname === '/api/tags')
      return json(res, 200, {
        models: [
          { name: 'glm-5.3', capabilities: ['tools'] },
          { name: 'glm-5.3-flash', capabilities: ['tools'] },
        ],
      });
    if (url.pathname === '/v1/messages' && req.method === 'POST') {
      if (session >= 1) return json(res, 429, { error: 'you have reached your session usage limit' }, { 'retry-after': '600' });
      session = Math.min(1, session + 0.04);
      weekly = Math.min(1, weekly + 0.01);
      const reqBody = JSON.parse(body || '{}');
      const model = reqBody.model ?? 'glm-5.3';
      const text = `Hello from the mock Ollama (${model}). Session usage is now ${Math.round(session * 100)}%.`;
      const input = Math.ceil(body.length / 4);
      const output = Math.ceil(text.length / 4);
      if (!reqBody.stream) {
        return json(res, 200, {
          id: 'msg_mock',
          type: 'message',
          role: 'assistant',
          model,
          content: [{ type: 'text', text }],
          stop_reason: 'end_turn',
          usage: { input_tokens: input, output_tokens: output },
        });
      }
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      const send = (type, data) => res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`);
      send('message_start', {
        message: {
          id: 'msg_mock',
          type: 'message',
          role: 'assistant',
          model,
          content: [],
          usage: { input_tokens: input, output_tokens: 1 },
        },
      });
      send('content_block_start', { index: 0, content_block: { type: 'text', text: '' } });
      const words = text.split(' ');
      let i = 0;
      const t = setInterval(() => {
        if (i < words.length) send('content_block_delta', { index: 0, delta: { type: 'text_delta', text: (i ? ' ' : '') + words[i++] } });
        else {
          clearInterval(t);
          send('content_block_stop', { index: 0 });
          send('message_delta', { delta: { stop_reason: 'end_turn' }, usage: { output_tokens: output } });
          send('message_stop', {});
          res.end();
        }
      }, 30);
      return;
    }
    json(res, 404, { error: `mock: no route for ${req.method} ${url.pathname}` });
  });
});

server.listen(port, '127.0.0.1', () => console.log(`mock Ollama Cloud on http://127.0.0.1:${port}`));

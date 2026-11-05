import http, { type IncomingMessage, type ServerResponse } from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import crypto from 'node:crypto';
import { mergeConfig, validateConfig, type GuardConfig, type Secrets } from './config/schema.js';
import { maskSecret } from './config/store.js';
import { anthropicError, estimateTokens, forwardMessages, forwardPassthrough, type ForwardContext } from './proxy/forward.js';
import type { GuardRuntime } from './runtime.js';

export interface ServerHooks {
  /** Persist config edits from the dashboard. Defaults to no-op (tests). */
  saveConfig?: (cfg: GuardConfig) => void | Promise<void>;
  saveSecrets?: (secrets: Secrets) => void | Promise<void>;
  /** Override the dashboard HTML location (tests). */
  dashboardFile?: string;
}

const MAX_BODY = 64 * 1024 * 1024;

function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (c: Buffer) => {
      size += c.length;
      if (size > MAX_BODY) {
        reject(new Error('Request body too large'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function json(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(JSON.stringify(body));
}

function locateDashboard(override?: string): string | undefined {
  if (override) return override;
  const here = path.dirname(fileURLToPath(import.meta.url));
  for (const p of [path.join(here, 'dashboard', 'index.html'), path.join(here, '..', 'src', 'dashboard', 'index.html')]) {
    if (fs.existsSync(p)) return p;
  }
  return undefined;
}

/** Only answer requests addressed to this machine (blocks DNS-rebinding tricks). */
function hostAllowed(req: IncomingMessage, port: number): boolean {
  const host = (req.headers.host ?? '').toLowerCase();
  const allowed = [`127.0.0.1:${port}`, `localhost:${port}`, `[::1]:${port}`, '127.0.0.1', 'localhost'];
  return allowed.includes(host);
}

/** Browsers send Origin; anything not our own dashboard is refused. */
function originAllowed(req: IncomingMessage, port: number): boolean {
  const origin = req.headers.origin;
  if (!origin) return true;
  return [`http://127.0.0.1:${port}`, `http://localhost:${port}`, `http://[::1]:${port}`].includes(origin.toLowerCase());
}

function tokenOk(req: IncomingMessage, token: string | undefined): boolean {
  if (!token) return false;
  const auth = req.headers.authorization ?? '';
  const presented = auth.toLowerCase().startsWith('bearer ') ? auth.slice(7).trim() : String(req.headers['x-api-key'] ?? '');
  const a = Buffer.from(presented);
  const b = Buffer.from(token);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

export function publicConfig(rt: GuardRuntime): unknown {
  const s = rt.secrets;
  return {
    config: rt.config,
    secrets: {
      ollamaApiKey: maskSecret(s.ollamaApiKey),
      telegramBotToken: s.telegramBotToken ? maskSecret(s.telegramBotToken) : null,
      discordWebhookUrl: s.discordWebhookUrl ? 'configured' : null,
      providers: Object.fromEntries(Object.entries(s.providers ?? {}).map(([k, v]) => [k, maskSecret(v)])),
    },
  };
}

export function createGuardServer(rt: GuardRuntime, hooks: ServerHooks = {}): http.Server {
  const dashboardPath = locateDashboard(hooks.dashboardFile);
  const sseClients = new Set<ServerResponse>();

  const broadcast = (event: string, data: unknown) => {
    const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
    for (const c of sseClients) c.write(payload);
  };
  rt.on('status', (s) => broadcast('status', s));
  rt.on('request', (r) => broadcast('request', r));
  rt.on('alert', (a, results) => broadcast('alert', { alert: a, results }));
  const heartbeat = setInterval(() => broadcast('ping', { t: Date.now() }), 25_000);
  heartbeat.unref();

  const ctx = (): ForwardContext => ({
    config: rt.config,
    secrets: rt.secrets,
    planState: rt.planState(),
    ratePerToken: rt.poller.snapshot?.ratePerToken,
    fetchImpl: rt.fetchImpl,
    onPrimaryLimited: (reason, ra) => rt.onPrimaryLimited(reason, ra),
    onFallbackServed: (t, reason) => rt.onFallbackServed(t, reason),
    onPrimaryOk: () => rt.onPrimaryOk(),
    onLog: (e) => rt.recordRequest(e),
  });

  const server = http.createServer((req, res) => {
    void handle(req, res).catch((err: Error) => {
      if (!res.headersSent) anthropicError(res, 500, 'api_error', `Ollama Guard internal error: ${err.message}`);
      else res.end();
    });
  });

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const port = rt.config.server.port;
    const url = new URL(req.url ?? '/', `http://127.0.0.1:${port}`);
    const p = url.pathname;
    const method = req.method ?? 'GET';

    if (!hostAllowed(req, port) && rt.config.server.host === '127.0.0.1') {
      json(res, 421, { error: 'Unexpected Host header' });
      return;
    }
    if (!originAllowed(req, port)) {
      json(res, 403, { error: 'Cross-origin requests are not allowed' });
      return;
    }

    // ---------------------------------------------------------- dashboard
    if (method === 'GET' && (p === '/' || p === '/dashboard' || p === '/dashboard/')) {
      if (p === '/') {
        res.writeHead(302, { location: '/dashboard' });
        res.end();
        return;
      }
      if (!dashboardPath) {
        res.writeHead(500, { 'content-type': 'text/plain' });
        res.end('Dashboard asset missing. Reinstall ollama-guard.');
        return;
      }
      res.writeHead(200, {
        'content-type': 'text/html; charset=utf-8',
        'cache-control': 'no-store',
        'content-security-policy':
          "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'",
        'x-content-type-options': 'nosniff',
        'referrer-policy': 'no-referrer',
      });
      res.end(fs.readFileSync(dashboardPath));
      return;
    }
    if (method === 'GET' && p === '/health') {
      json(res, 200, { ok: true, version: rt.status().version });
      return;
    }

    // ---------------------------------------------------------- guard API
    if (p.startsWith('/api/guard/')) {
      const sub = p.slice('/api/guard/'.length);
      const mutating = method !== 'GET';
      if (mutating && req.headers['x-ollama-guard'] !== '1') {
        json(res, 403, { error: 'Missing x-ollama-guard header' });
        return;
      }
      if (method === 'GET' && sub === 'status') return json(res, 200, rt.status());
      if (method === 'GET' && sub === 'stats') {
        const days = Math.min(90, Math.max(1, Number(url.searchParams.get('days') ?? 14) || 14));
        return json(res, 200, rt.logs.stats(days));
      }
      if (method === 'GET' && sub === 'logs') {
        const limit = Math.min(1000, Math.max(1, Number(url.searchParams.get('limit') ?? 100) || 100));
        return json(res, 200, rt.logs.latest(limit));
      }
      if (method === 'GET' && sub === 'config') return json(res, 200, publicConfig(rt));
      if (method === 'GET' && sub === 'events') {
        res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive' });
        res.write(`event: status\ndata: ${JSON.stringify(rt.status())}\n\n`);
        sseClients.add(res);
        req.on('close', () => sseClients.delete(res));
        return;
      }
      if (method === 'PUT' && sub === 'config') {
        const raw = JSON.parse((await readBody(req)).toString('utf8') || '{}') as unknown;
        const next = mergeConfig(rt.config, raw);
        // Port/host changes need a restart; keep the running values.
        const problems = validateConfig(next);
        if (problems.length) return json(res, 400, { error: 'Invalid configuration', problems });
        await hooks.saveConfig?.(next);
        rt.reload(next, rt.secrets);
        return json(res, 200, publicConfig(rt));
      }
      if (method === 'PUT' && sub === 'secrets') {
        const patch = JSON.parse((await readBody(req)).toString('utf8') || '{}') as Partial<Secrets>;
        const next: Secrets = { ...rt.secrets, providers: { ...(rt.secrets.providers ?? {}) } };
        for (const k of ['ollamaApiKey', 'telegramBotToken', 'discordWebhookUrl'] as const) {
          const v = patch[k];
          if (typeof v === 'string') {
            if (v) next[k] = v.trim();
            else delete next[k];
          }
        }
        for (const [name, v] of Object.entries(patch.providers ?? {})) {
          if (typeof v === 'string' && v) next.providers![name] = v.trim();
          else delete next.providers![name];
        }
        await hooks.saveSecrets?.(next);
        rt.reload(rt.config, next);
        return json(res, 200, publicConfig(rt));
      }
      if (method === 'POST' && sub === 'usage/refresh') {
        await rt.poller.refresh();
        return json(res, 200, rt.status());
      }
      if (method === 'POST' && sub === 'fallback/reset') {
        rt.resetCircuit();
        return json(res, 200, rt.status());
      }
      if (method === 'POST' && sub === 'alerts/test') {
        const results = await rt.raise({
          kind: 'test',
          level: 'info',
          title: 'Test alert',
          message: 'Ollama Guard can reach you here. You will hear from it when usage gets close to your limits.',
          at: new Date().toISOString(),
        });
        return json(res, 200, { results });
      }
      return json(res, 404, { error: `Unknown endpoint ${method} ${p}` });
    }

    // ---------------------------------------------------------- proxy
    if (rt.config.server.requireToken && !tokenOk(req, rt.secrets.proxyToken)) {
      anthropicError(
        res,
        401,
        'authentication_error',
        'Ollama Guard: set ANTHROPIC_AUTH_TOKEN to your proxy token (see `ollama-guard env`).',
      );
      return;
    }
    const raw = await readBody(req);
    if (method === 'POST' && p === '/v1/messages') {
      await forwardMessages(req, res, raw, ctx());
      return;
    }
    if (method === 'POST' && p === '/v1/messages/count_tokens' && rt.config.server.localCountTokens) {
      let body: unknown = {};
      try {
        body = JSON.parse(raw.toString('utf8'));
      } catch {
        /* estimate from nothing */
      }
      json(res, 200, { input_tokens: estimateTokens(body) });
      return;
    }
    await forwardPassthrough(req, res, raw, ctx(), rt.primaryForPassthrough());
  }

  server.on('close', () => {
    clearInterval(heartbeat);
    for (const c of sseClients) c.end();
  });
  // Long generations: never let Node time the socket out underneath us.
  server.requestTimeout = 0;
  server.headersTimeout = 60_000;
  server.keepAliveTimeout = 65_000;
  return server;
}

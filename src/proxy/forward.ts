import type { IncomingMessage, ServerResponse } from 'node:http';
import crypto from 'node:crypto';
import type { GuardConfig, Secrets } from '../config/schema.js';
import type { RequestLog } from '../logs/store.js';
import { isLimitError, limitReason } from './limits.js';
import { estimateCost, planAttempts, type PlanState, type Target } from './plan.js';
import { detectProject } from './project.js';
import { applyUsage, SseUsageTap } from './sse.js';

export interface ForwardContext {
  config: GuardConfig;
  secrets: Secrets;
  planState: PlanState;
  ratePerToken?: Record<string, number>;
  fetchImpl?: typeof fetch;
  /** Called when Ollama Cloud answers with a limit error. */
  onPrimaryLimited(reason: string, retryAfterSec?: number): void;
  /** Called when a fallback provider served a request. */
  onFallbackServed(target: Target, reason: string): void;
  /** Called when Ollama Cloud served a request successfully. */
  onPrimaryOk(): void;
  onLog(entry: RequestLog): void;
}

const HOP_BY_HOP = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
  'host',
  'content-length',
  'accept-encoding',
  'authorization',
  'x-api-key',
  'origin',
  'referer',
  'cookie',
  'x-ollama-guard-project',
]);

const RESPONSE_SKIP = new Set(['content-encoding', 'content-length', 'transfer-encoding', 'connection', 'keep-alive']);

export function upstreamHeaders(incoming: IncomingMessage['headers'], target: Target): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(incoming)) {
    if (v === undefined || HOP_BY_HOP.has(k.toLowerCase())) continue;
    out[k] = Array.isArray(v) ? v.join(', ') : v;
  }
  if (!out['anthropic-version']) out['anthropic-version'] = '2023-06-01';
  out['accept-encoding'] = 'identity';
  out['user-agent'] = `${out['user-agent'] ?? 'claude-code'} ollama-guard`;
  return { ...out, ...target.auth };
}

export function anthropicError(res: ServerResponse, status: number, type: string, message: string): void {
  if (res.headersSent) {
    res.end();
    return;
  }
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ type: 'error', error: { type, message } }));
}

function joinUrl(base: string, path: string): string {
  return base.replace(/\/+$/, '') + path;
}

/**
 * Forward POST /v1/messages through the plan: Ollama Cloud first, fallback
 * chain on limit errors. Streams SSE through untouched while tapping usage.
 */
export async function forwardMessages(req: IncomingMessage, res: ServerResponse, raw: Buffer, ctx: ForwardContext): Promise<void> {
  const started = Date.now();
  const id = crypto.randomUUID();
  let body: Record<string, unknown> | undefined;
  try {
    body = JSON.parse(raw.toString('utf8')) as Record<string, unknown>;
  } catch {
    anthropicError(res, 400, 'invalid_request_error', 'Request body is not valid JSON.');
    return;
  }
  const requestedModel = typeof body.model === 'string' ? body.model : '';
  const stream = body.stream === true;
  const project = detectProject(req.headers, body);
  const plan = planAttempts(requestedModel, ctx.config, ctx.secrets, ctx.planState);
  const f = ctx.fetchImpl ?? fetch;

  // Abort upstream work if Claude Code goes away (Esc / Ctrl+C).
  const controller = new AbortController();
  const onClose = () => {
    if (!res.writableEnded) controller.abort();
  };
  res.on('close', onClose);
  const timeout = setTimeout(() => controller.abort(), ctx.config.ollama.requestTimeoutSec * 1000);
  timeout.unref?.();

  let fallbackReason: string | undefined = plan.primarySkipped ? `Ollama ${plan.primarySkipped}` : undefined;
  let last: { status: number; body: string; headers: Headers } | undefined;
  let lastNetworkError: string | undefined;

  const baseLog = (target: Target | undefined, status: number, extra: Partial<RequestLog> = {}): RequestLog => ({
    id,
    ts: new Date(started).toISOString(),
    method: 'POST',
    path: req.url ?? '/v1/messages',
    project,
    requestedModel,
    model: target?.model,
    provider: target?.name ?? 'none',
    status,
    stream,
    inputTokens: 0,
    outputTokens: 0,
    costUsd: 0,
    latencyMs: Date.now() - started,
    fallback: target?.kind === 'fallback' ? fallbackReason : undefined,
    downgraded: target?.downgraded || undefined,
    ...extra,
  });

  try {
    for (let i = 0; i < plan.attempts.length; i++) {
      const target = plan.attempts[i] as Target;
      const isLast = i === plan.attempts.length - 1;
      const payload = JSON.stringify({ ...body, model: target.model });
      let upstream: Response;
      try {
        upstream = await f(joinUrl(target.baseUrl, '/v1/messages'), {
          method: 'POST',
          headers: { ...upstreamHeaders(req.headers, target), 'content-type': 'application/json' },
          body: payload,
          signal: controller.signal,
        });
      } catch (err) {
        if (controller.signal.aborted) {
          ctx.onLog(baseLog(target, 499, { error: 'client closed request' }));
          return;
        }
        lastNetworkError = `${target.name}: ${(err as Error).message}`;
        const canFailOver = ctx.config.fallback.enabled && !isLast;
        if (target.kind === 'primary' && canFailOver && ctx.config.fallback.onNetworkError) {
          fallbackReason = `Ollama ${limitReason(0, '')}`;
          continue;
        }
        if (target.kind === 'fallback' && !isLast) continue;
        break;
      }

      if (!upstream.ok) {
        const text = await upstream.text();
        last = { status: upstream.status, body: text, headers: upstream.headers };
        const limited = isLimitError({ status: upstream.status, body: text, triggerStatuses: ctx.config.fallback.triggerStatuses });
        if (target.kind === 'primary' && limited) {
          const ra = Number(upstream.headers.get('retry-after'));
          ctx.onPrimaryLimited(limitReason(upstream.status, text), Number.isFinite(ra) && ra > 0 ? ra : undefined);
          fallbackReason = `Ollama ${limitReason(upstream.status, text)}`;
          if (!isLast) continue;
        } else if (
          target.kind === 'fallback' &&
          !isLast &&
          (limited || upstream.status >= 500 || upstream.status === 401 || upstream.status === 404)
        ) {
          // A broken fallback should not stop us trying the next one.
          continue;
        }
        relayError(res, last, target);
        ctx.onLog(baseLog(target, upstream.status, { error: summarize(text) }));
        return;
      }

      // Success: stream or buffer the body through.
      if (target.kind === 'primary') ctx.onPrimaryOk();
      else ctx.onFallbackServed(target, fallbackReason ?? 'fallback');
      const headers: Record<string, string> = {};
      upstream.headers.forEach((v, k) => {
        if (!RESPONSE_SKIP.has(k.toLowerCase())) headers[k] = v;
      });
      headers['x-ollama-guard-provider'] = target.name;
      headers['x-ollama-guard-model'] = target.model;
      res.writeHead(upstream.status, headers);
      res.flushHeaders?.();

      const tap = new SseUsageTap();
      const isSse = (upstream.headers.get('content-type') ?? '').includes('text/event-stream');
      const jsonChunks: Buffer[] = [];
      let jsonBytes = 0;
      let ttfb: number | undefined;
      if (upstream.body) {
        const reader = upstream.body.getReader();
        try {
          for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            if (ttfb === undefined) ttfb = Date.now() - started;
            if (isSse) tap.push(value);
            else if (jsonBytes < 8_000_000) {
              jsonChunks.push(Buffer.from(value));
              jsonBytes += value.byteLength;
            }
            if (!res.write(value)) await new Promise<void>((r) => res.once('drain', r));
          }
        } catch (err) {
          if (!controller.signal.aborted) tap.error = (err as Error).message;
        }
      }
      res.end();
      if (isSse) tap.end();
      else {
        try {
          applyUsage(tap, JSON.parse(Buffer.concat(jsonChunks).toString('utf8')) as Record<string, unknown>);
        } catch {
          /* non-JSON body */
        }
      }
      const cost = estimateCost(target.name, target.model, tap.inputTokens, tap.outputTokens, ctx.config.pricing, ctx.ratePerToken);
      ctx.onLog(
        baseLog(target, controller.signal.aborted ? 499 : upstream.status, {
          inputTokens: tap.inputTokens,
          outputTokens: tap.outputTokens,
          costUsd: cost,
          ttfbMs: ttfb,
          latencyMs: Date.now() - started,
          error: tap.error,
        }),
      );
      return;
    }

    // Every attempt failed.
    if (last) {
      relayError(res, last, plan.attempts[plan.attempts.length - 1]);
      ctx.onLog(baseLog(plan.attempts[plan.attempts.length - 1], last.status, { error: summarize(last.body) }));
    } else {
      const msg = `Ollama Guard could not reach any upstream. ${lastNetworkError ?? ''}`.trim();
      anthropicError(res, 502, 'api_error', msg);
      ctx.onLog(baseLog(undefined, 502, { error: msg }));
    }
  } finally {
    clearTimeout(timeout);
    res.off('close', onClose);
  }
}

function relayError(res: ServerResponse, last: { status: number; body: string; headers: Headers }, target: Target | undefined): void {
  if (res.headersSent) {
    res.end();
    return;
  }
  const headers: Record<string, string> = { 'content-type': last.headers.get('content-type') ?? 'application/json' };
  const ra = last.headers.get('retry-after');
  if (ra) headers['retry-after'] = ra;
  if (target) headers['x-ollama-guard-provider'] = target.name;
  // Ollama errors look like {"error":"..."}; Claude Code expects Anthropic's shape.
  let body = last.body;
  try {
    const j = JSON.parse(body) as { type?: string; error?: unknown };
    if (j.type !== 'error' && typeof j.error === 'string') {
      body = JSON.stringify({ type: 'error', error: { type: errorType(last.status), message: j.error } });
      headers['content-type'] = 'application/json';
    }
  } catch {
    if (body.trim()) {
      body = JSON.stringify({ type: 'error', error: { type: errorType(last.status), message: body.slice(0, 500) } });
      headers['content-type'] = 'application/json';
    }
  }
  res.writeHead(last.status, headers);
  res.end(body);
}

function errorType(status: number): string {
  if (status === 400) return 'invalid_request_error';
  if (status === 401) return 'authentication_error';
  if (status === 403) return 'permission_error';
  if (status === 404) return 'not_found_error';
  if (status === 413) return 'request_too_large';
  if (status === 429) return 'rate_limit_error';
  if (status === 529 || status === 503) return 'overloaded_error';
  return 'api_error';
}

function summarize(text: string): string {
  try {
    const j = JSON.parse(text) as { error?: string | { message?: string } };
    if (typeof j.error === 'string') return j.error.slice(0, 200);
    if (j.error && typeof j.error.message === 'string') return j.error.message.slice(0, 200);
  } catch {
    /* raw */
  }
  return text.slice(0, 200);
}

/** Generic pass-through for any other path (e.g. GET /v1/models) to Ollama Cloud. */
export async function forwardPassthrough(
  req: IncomingMessage,
  res: ServerResponse,
  raw: Buffer,
  ctx: ForwardContext,
  target: Target,
): Promise<void> {
  const f = ctx.fetchImpl ?? fetch;
  try {
    const hasBody = !['GET', 'HEAD'].includes(req.method ?? 'GET');
    const upstream = await f(joinUrl(target.baseUrl, req.url ?? '/'), {
      method: req.method,
      headers: upstreamHeaders(req.headers, target),
      body: hasBody && raw.length ? raw : undefined,
      signal: AbortSignal.timeout(60_000),
    });
    const headers: Record<string, string> = {};
    upstream.headers.forEach((v, k) => {
      if (!RESPONSE_SKIP.has(k.toLowerCase())) headers[k] = v;
    });
    res.writeHead(upstream.status, headers);
    res.end(Buffer.from(await upstream.arrayBuffer()));
  } catch (err) {
    anthropicError(res, 502, 'api_error', `Upstream unreachable: ${(err as Error).message}`);
  }
}

/** Ollama does not implement /v1/messages/count_tokens; estimate locally (~4 chars/token). */
export function estimateTokens(body: unknown): number {
  const b = (body ?? {}) as { system?: unknown; messages?: unknown; tools?: unknown };
  const chars = JSON.stringify(b.system ?? '').length + JSON.stringify(b.messages ?? []).length + JSON.stringify(b.tools ?? []).length;
  return Math.max(1, Math.ceil(chars / 4));
}

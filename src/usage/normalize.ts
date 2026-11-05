/**
 * Turn Ollama's usage/balance responses into one stable shape.
 *
 * Ollama has shipped more than one shape over time, so this accepts all of
 * the ones we know about (verified against docs.ollama.com, Nov 2026):
 *
 *  1. GET /api/balance, current plans:
 *       { included: { balance_usd, allowance_usd, period: { from, until } }, purchased: { balance_usd } }
 *  2. GET /api/balance, legacy plans with session/weekly limits:
 *       { included: { session: { remaining_percent, resets_at }, weekly: {...} }, purchased }
 *  3. A `limits` object on /api/usage (reported by some users / older builds):
 *       { limits: { session: { usage: 0..1, resets_at? }, weekly: { usage: 0..1, resets_at? } } }
 *  4. GET /api/usage history: { totals, buckets[], ... } for request counts, tokens and USD.
 */

export type WindowId = 'session' | 'weekly' | 'monthly';

export interface UsageWindow {
  id: WindowId;
  label: string;
  /** Fraction used, 0..1 (may exceed 1 slightly when over the limit). */
  used: number;
  resetsAt?: string;
}

export interface UsageTotals {
  requests: number;
  usd: number;
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
}

export interface ModelUsage extends UsageTotals {
  model: string;
}

export interface UsageSnapshot {
  fetchedAt: string;
  ok: boolean;
  error?: string;
  windows: UsageWindow[];
  /** The tightest window (highest `used`), if any. */
  headline?: UsageWindow;
  includedBalanceUsd?: number;
  allowanceUsd?: number;
  purchasedUsd?: number;
  /** Today so far (UTC day, as Ollama buckets it). */
  today?: UsageTotals;
  /** The whole history range returned (default 7 days). */
  range?: UsageTotals & { range: string };
  models?: ModelUsage[];
  /** Blended USD per token, by model, derived from the history API. */
  ratePerToken?: Record<string, number>;
  scope?: 'self' | 'team';
}

type J = Record<string, unknown>;
const obj = (v: unknown): J | undefined => (typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as J) : undefined);
const num = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);
const str = (v: unknown): string | undefined => (typeof v === 'string' && v ? v : undefined);
const clamp = (n: number) => Math.round(Math.max(0, Math.min(1.5, n)) * 10_000) / 10_000;

function resetOf(o: J): string | undefined {
  return str(o.resets_at) ?? str(o.reset_at) ?? str(o.resetsAt) ?? str(o.resetAt) ?? str(o.reset);
}

function totalsOf(o: J | undefined): UsageTotals | undefined {
  if (!o) return undefined;
  return {
    requests: num(o.request_count) ?? 0,
    usd: num(o.usage_usd) ?? 0,
    inputTokens: num(o.input_tokens) ?? 0,
    cachedInputTokens: num(o.cached_input_tokens) ?? 0,
    outputTokens: num(o.output_tokens) ?? 0,
  };
}

const LABELS: Record<WindowId, string> = { session: 'Session', weekly: 'Weekly', monthly: 'Monthly credits' };

export function windowsFromBalance(balance: unknown): UsageWindow[] {
  const included = obj(obj(balance)?.included);
  if (!included) return [];
  const out: UsageWindow[] = [];
  for (const id of ['session', 'weekly'] as const) {
    const w = obj(included[id]);
    const remaining = num(w?.remaining_percent);
    if (w && remaining !== undefined) out.push({ id, label: LABELS[id], used: clamp(1 - remaining / 100), resetsAt: resetOf(w) });
  }
  const allowance = num(included.allowance_usd);
  const bal = num(included.balance_usd);
  if (allowance && allowance > 0 && bal !== undefined) {
    out.push({
      id: 'monthly',
      label: LABELS.monthly,
      used: clamp(1 - bal / allowance),
      resetsAt: str(obj(included.period)?.until),
    });
  }
  return out;
}

export function windowsFromLimits(usage: unknown): UsageWindow[] {
  const limits = obj(obj(usage)?.limits);
  if (!limits) return [];
  const out: UsageWindow[] = [];
  for (const id of ['session', 'weekly'] as const) {
    const w = obj(limits[id]);
    if (!w) continue;
    let used = num(w.usage) ?? num(w.used);
    const remaining = num(w.remaining_percent);
    if (used === undefined && remaining !== undefined) used = 1 - remaining / 100;
    if (used !== undefined && used > 1.5) used = used / 100; // tolerate percentages
    if (used !== undefined) out.push({ id, label: LABELS[id], used: clamp(used), resetsAt: resetOf(w) });
  }
  return out;
}

export function normalizeUsage(input: { balance?: unknown; usage?: unknown; scope?: 'self' | 'team'; now?: Date }): UsageSnapshot {
  const now = input.now ?? new Date();
  const byId = new Map<WindowId, UsageWindow>();
  // Balance is authoritative; the `limits` shape fills gaps.
  for (const w of windowsFromLimits(input.usage)) byId.set(w.id, w);
  for (const w of windowsFromBalance(input.balance)) byId.set(w.id, w);
  const order: WindowId[] = ['session', 'weekly', 'monthly'];
  const windows = order.map((id) => byId.get(id)).filter((w): w is UsageWindow => Boolean(w));
  const headline = windows.reduce<UsageWindow | undefined>((a, w) => (!a || w.used > a.used ? w : a), undefined);

  const snap: UsageSnapshot = {
    fetchedAt: now.toISOString(),
    ok: true,
    windows,
    headline,
    scope: input.scope,
  };

  const included = obj(obj(input.balance)?.included);
  snap.includedBalanceUsd = num(included?.balance_usd);
  snap.allowanceUsd = num(included?.allowance_usd);
  snap.purchasedUsd = num(obj(obj(input.balance)?.purchased)?.balance_usd);

  const usage = obj(input.usage);
  if (usage) {
    const totals = totalsOf(obj(usage.totals));
    if (totals) snap.range = { ...totals, range: str(usage.range) ?? '7d' };
    const buckets = Array.isArray(usage.buckets) ? ((usage.buckets as unknown[]).map(obj).filter(Boolean) as J[]) : [];
    const last = buckets[buckets.length - 1];
    if (last && usage.granularity === 'day') snap.today = totalsOf(last);
    const groups = Array.isArray(obj(usage.totals)?.groups)
      ? ((obj(usage.totals)?.groups as unknown[]).map(obj).filter(Boolean) as J[])
      : [];
    if (groups.length) {
      snap.models = groups.map((g) => ({ model: str(g.model) ?? 'unknown', ...(totalsOf(g) as UsageTotals) }));
      snap.ratePerToken = {};
      for (const m of snap.models) {
        const toks = m.inputTokens + m.outputTokens;
        if (toks > 0 && m.usd > 0) snap.ratePerToken[m.model] = m.usd / toks;
      }
    }
  }
  return snap;
}

export function emptySnapshot(error?: string): UsageSnapshot {
  return { fetchedAt: new Date().toISOString(), ok: !error, error, windows: [] };
}

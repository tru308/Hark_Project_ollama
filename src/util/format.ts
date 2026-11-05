/** Human-friendly "2h 10m" style durations. */
export function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return 'now';
  const totalMin = Math.round(ms / 60_000);
  if (totalMin < 1) return '<1m';
  const d = Math.floor(totalMin / 1440);
  const h = Math.floor((totalMin % 1440) / 60);
  const m = totalMin % 60;
  if (d > 0) return h > 0 ? `${d}d ${h}h` : `${d}d`;
  if (h > 0) return m > 0 ? `${h}h ${m}m` : `${h}h`;
  return `${m}m`;
}

export function untilIso(iso: string | undefined, now = Date.now()): string | undefined {
  if (!iso) return undefined;
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return undefined;
  return formatDuration(t - now);
}

export function pct(fraction: number): string {
  return `${Math.round(Math.max(0, fraction) * 100)}%`;
}

export function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(n >= 10_000_000 ? 0 : 1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(n >= 10_000 ? 0 : 1)}k`;
  return String(Math.round(n));
}

export function formatUsd(n: number): string {
  if (n === 0) return '$0.00';
  if (n < 0.01) return `$${n.toFixed(4)}`;
  return `$${n.toFixed(2)}`;
}

/** Local calendar date (YYYY-MM-DD) in the machine's timezone. */
export function localDate(ts: number | Date = Date.now()): string {
  const d = ts instanceof Date ? ts : new Date(ts);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

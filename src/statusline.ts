import type { GuardStatus } from './runtime.js';
import { untilIso } from './util/format.js';

export interface StatuslineOptions {
  color?: boolean;
  now?: number;
}

const paint = (on: boolean, code: string, s: string) => (on ? `\x1b[${code}m${s}\x1b[0m` : s);

/**
 * One calm line for Claude Code's status bar, e.g.
 *   Ollama 63% · resets 2h 10m · fallback: off
 */
export function formatStatusline(status: GuardStatus | undefined, opts: StatuslineOptions = {}): string {
  const color = opts.color ?? true;
  const dim = (s: string) => paint(color, '2', s);
  if (!status) return `${paint(color, '33', 'Ollama Guard offline')} ${dim('· run `ollama-guard start`')}`;

  const parts: string[] = [];
  const h = status.usage?.headline;
  if (h) {
    const pctNum = Math.round(h.used * 100);
    const code = h.used >= 0.9 ? '31' : h.used >= 0.7 ? '33' : '32';
    const label = status.usage && status.usage.windows.length > 1 ? `Ollama ${h.id}` : 'Ollama';
    parts.push(`${label} ${paint(color, code, `${pctNum}%`)}`);
    const reset = untilIso(h.resetsAt, opts.now);
    if (reset) parts.push(`resets ${reset}`);
  } else if (!status.account.keyConfigured) {
    parts.push(`Ollama ${paint(color, '33', 'no key')}`);
  } else {
    parts.push(`Ollama ${dim(status.usage?.error ? 'usage unavailable' : '…')}`);
  }

  if (status.fallback.active) {
    const who = status.fallback.provider ?? status.fallback.chain[0]?.name ?? 'on';
    parts.push(paint(color, '35', `fallback: ${who}${status.fallback.model ? ` (${status.fallback.model})` : ''}`));
  } else if (status.downgrade.active) {
    parts.push(paint(color, '36', 'downgraded'));
    parts.push(`fallback: ${status.fallback.enabled ? 'ready' : 'off'}`);
  } else {
    parts.push(`fallback: ${status.fallback.enabled ? 'ready' : 'off'}`);
  }
  return parts.join(dim(' · '));
}

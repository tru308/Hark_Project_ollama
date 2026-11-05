import type { UsageSnapshot, UsageWindow } from '../usage/normalize.js';
import { formatDuration } from '../util/format.js';

export type AlertKind = 'threshold' | 'reset' | 'fallback' | 'recovered' | 'test';

export interface Alert {
  kind: AlertKind;
  title: string;
  message: string;
  /** 'info' | 'warning' | 'critical' drives styling in channels and the dashboard. */
  level: 'info' | 'warning' | 'critical';
  windowId?: string;
  threshold?: number;
  at: string;
}

export interface AlertEngineOptions {
  /** Percentages, e.g. [70, 90, 100]. */
  thresholds: number[];
  onReset: boolean;
  accountLabel?: string;
}

/**
 * Pure threshold logic. Feed it consecutive snapshots; it returns the alerts
 * to send. It remembers which (window, reset period, threshold) triples have
 * fired so restarts and repeated polls never spam you.
 */
export class AlertEngine {
  private fired: Set<string>;

  constructor(
    private opts: AlertEngineOptions,
    fired: Iterable<string> = [],
  ) {
    this.fired = new Set(fired);
  }

  setOptions(opts: AlertEngineOptions): void {
    this.opts = opts;
  }

  /** Keys of alerts already fired, for persistence. */
  firedKeys(): string[] {
    return [...this.fired];
  }

  evaluate(next: UsageSnapshot, prev: UsageSnapshot | undefined, now = new Date()): Alert[] {
    if (!next.ok && next.windows.length === 0) return [];
    const alerts: Alert[] = [];
    const thresholds = [...this.opts.thresholds].sort((a, b) => a - b);
    const minThreshold = thresholds[0] ?? 70;

    for (const w of next.windows) {
      const before = prev?.windows.find((p) => p.id === w.id);

      // 1. Reset detection: the window's reset time moved forward, or usage
      //    fell sharply from an alert-worthy level.
      if (before && this.isReset(before, w, minThreshold)) {
        this.clearWindow(w.id);
        if (this.opts.onReset) {
          alerts.push({
            kind: 'reset',
            level: 'info',
            windowId: w.id,
            title: `${w.label} limit reset`,
            message: `Your Ollama ${w.label.toLowerCase()} usage is back to ${Math.round(w.used * 100)}%. Fallback can stand down.`,
            at: now.toISOString(),
          });
        }
      }

      // 2. Threshold crossings: only the highest newly crossed threshold.
      const usedPct = w.used * 100;
      const crossed = thresholds.filter((t) => usedPct + 1e-9 >= t && !this.fired.has(this.key(w, t)));
      if (crossed.length) {
        const t = crossed[crossed.length - 1] as number;
        for (const c of crossed) this.fired.add(this.key(w, c));
        const resetIn = w.resetsAt ? formatDuration(Date.parse(w.resetsAt) - now.getTime()) : undefined;
        alerts.push({
          kind: 'threshold',
          level: t >= 100 ? 'critical' : t >= 90 ? 'warning' : 'info',
          windowId: w.id,
          threshold: t,
          title: t >= 100 ? `${w.label} limit reached` : `${w.label} usage at ${Math.round(usedPct)}%`,
          message:
            (t >= 100
              ? `You've used your Ollama ${w.label.toLowerCase()} allowance.`
              : `You've crossed ${t}% of your Ollama ${w.label.toLowerCase()} allowance.`) + (resetIn ? ` Resets in ${resetIn}.` : ''),
          at: now.toISOString(),
        });
      }
    }
    return alerts;
  }

  private isReset(before: UsageWindow, after: UsageWindow, minThreshold: number): boolean {
    const wasHigh = before.used * 100 >= minThreshold;
    if (!wasHigh) return false;
    const movedForward = before.resetsAt && after.resetsAt && Date.parse(after.resetsAt) > Date.parse(before.resetsAt) + 60_000;
    const dropped = after.used < before.used - 0.25;
    return Boolean(movedForward && after.used < before.used) || dropped;
  }

  /**
   * One alert per (window, reset period, threshold). The reset time is rounded
   * to the hour so small drifts in `resets_at` between polls never re-alert.
   */
  private key(w: UsageWindow, t: number): string {
    const r = w.resetsAt ? Date.parse(w.resetsAt) : NaN;
    const period = Number.isNaN(r) ? 'none' : new Date(Math.round(r / 3_600_000) * 3_600_000).toISOString();
    return `${w.id}|${period}|${t}`;
  }

  private clearWindow(id: string): void {
    for (const k of [...this.fired]) if (k.startsWith(`${id}|`)) this.fired.delete(k);
  }
}

export function fallbackAlert(provider: string, model: string, reason: string, now = new Date()): Alert {
  return {
    kind: 'fallback',
    level: 'warning',
    title: 'Fallback active',
    message: `Ollama Cloud ${reason}. Requests now go to ${provider} (${model}) until your limit resets.`,
    at: now.toISOString(),
  };
}

export function recoveredAlert(now = new Date()): Alert {
  return {
    kind: 'recovered',
    level: 'info',
    title: 'Back on Ollama Cloud',
    message: 'Your Ollama limit has room again. Requests are going to Ollama Cloud.',
    at: now.toISOString(),
  };
}

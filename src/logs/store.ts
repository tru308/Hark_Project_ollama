import fs from 'node:fs';
import path from 'node:path';
import { localDate } from '../util/format.js';

/**
 * One line per proxied request, in daily JSONL files:
 *   ~/.ollama-guard/logs/requests-YYYY-MM-DD.jsonl
 * Plain files on purpose: no native modules to compile on Windows, easy to
 * grep, easy to delete. Prompt and response bodies are never stored.
 */
export interface RequestLog {
  id: string;
  ts: string;
  method: string;
  path: string;
  project: string;
  requestedModel?: string;
  model?: string;
  provider: string;
  status: number;
  stream: boolean;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
  latencyMs: number;
  ttfbMs?: number;
  fallback?: string;
  downgraded?: boolean;
  error?: string;
}

export interface DayStat {
  date: string;
  requests: number;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
  fallbacks: number;
  errors: number;
}

export interface GroupStat {
  key: string;
  requests: number;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
}

export interface Stats {
  days: DayStat[];
  projects: GroupStat[];
  models: GroupStat[];
  providers: GroupStat[];
  totals: Omit<DayStat, 'date'>;
}

const FILE_RE = /^requests-(\d{4}-\d{2}-\d{2})\.jsonl$/;

export class LogStore {
  private recent: RequestLog[] = [];
  private all: RequestLog[] = [];
  private readonly recentCap = 1000;

  constructor(
    private readonly dir: string,
    private retentionDays = 30,
  ) {}

  setRetention(days: number): void {
    this.retentionDays = days;
  }

  /** Load the retained window into memory and purge expired files. */
  load(): void {
    fs.mkdirSync(this.dir, { recursive: true });
    this.purge();
    const files = fs
      .readdirSync(this.dir)
      .filter((f) => FILE_RE.test(f))
      .sort();
    const entries: RequestLog[] = [];
    for (const f of files) {
      const text = fs.readFileSync(path.join(this.dir, f), 'utf8');
      for (const line of text.split('\n')) {
        if (!line.trim()) continue;
        try {
          entries.push(JSON.parse(line) as RequestLog);
        } catch {
          /* skip a torn line */
        }
      }
    }
    this.all = entries;
    this.recent = entries.slice(-this.recentCap);
  }

  append(entry: RequestLog): void {
    this.all.push(entry);
    this.recent.push(entry);
    if (this.recent.length > this.recentCap) this.recent.shift();
    const file = path.join(this.dir, `requests-${localDate(Date.parse(entry.ts))}.jsonl`);
    try {
      fs.mkdirSync(this.dir, { recursive: true });
      fs.appendFileSync(file, `${JSON.stringify(entry)}\n`, { mode: 0o600 });
    } catch {
      /* logging must never break proxying */
    }
  }

  latest(limit = 100): RequestLog[] {
    return this.recent.slice(-limit).reverse();
  }

  stats(days = 14, now = new Date()): Stats {
    const dates: string[] = [];
    for (let i = days - 1; i >= 0; i--) {
      const d = new Date(now);
      d.setDate(d.getDate() - i);
      dates.push(localDate(d));
    }
    const first = dates[0] as string;
    const dayMap = new Map<string, DayStat>(
      dates.map((date) => [date, { date, requests: 0, inputTokens: 0, outputTokens: 0, costUsd: 0, fallbacks: 0, errors: 0 }]),
    );
    const groups = {
      projects: new Map<string, GroupStat>(),
      models: new Map<string, GroupStat>(),
      providers: new Map<string, GroupStat>(),
    };
    const bump = (m: Map<string, GroupStat>, key: string, e: RequestLog) => {
      const g = m.get(key) ?? { key, requests: 0, inputTokens: 0, outputTokens: 0, costUsd: 0 };
      g.requests++;
      g.inputTokens += e.inputTokens;
      g.outputTokens += e.outputTokens;
      g.costUsd += e.costUsd;
      m.set(key, g);
    };
    for (const e of this.all) {
      const date = localDate(Date.parse(e.ts));
      if (date < first) continue;
      const d = dayMap.get(date);
      if (!d) continue;
      d.requests++;
      d.inputTokens += e.inputTokens;
      d.outputTokens += e.outputTokens;
      d.costUsd += e.costUsd;
      if (e.fallback) d.fallbacks++;
      if (e.status >= 400) d.errors++;
      bump(groups.projects, e.project || 'unknown', e);
      bump(groups.models, e.model || e.requestedModel || 'unknown', e);
      bump(groups.providers, e.provider, e);
    }
    const dayList = [...dayMap.values()];
    const totals = dayList.reduce(
      (t, d) => ({
        requests: t.requests + d.requests,
        inputTokens: t.inputTokens + d.inputTokens,
        outputTokens: t.outputTokens + d.outputTokens,
        costUsd: t.costUsd + d.costUsd,
        fallbacks: t.fallbacks + d.fallbacks,
        errors: t.errors + d.errors,
      }),
      { requests: 0, inputTokens: 0, outputTokens: 0, costUsd: 0, fallbacks: 0, errors: 0 },
    );
    const sorted = (m: Map<string, GroupStat>) =>
      [...m.values()].sort((a, b) => b.inputTokens + b.outputTokens - (a.inputTokens + a.outputTokens));
    return { days: dayList, projects: sorted(groups.projects), models: sorted(groups.models), providers: sorted(groups.providers), totals };
  }

  private purge(): void {
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - this.retentionDays);
    const cut = localDate(cutoff);
    for (const f of fs.readdirSync(this.dir)) {
      const m = FILE_RE.exec(f);
      if (m && (m[1] as string) < cut) {
        try {
          fs.rmSync(path.join(this.dir, f));
        } catch {
          /* ignore */
        }
      }
    }
  }
}

/** Read the last `n` entries straight from disk (used by `ollama-guard logs`). */
export function tailLogs(dir: string, n: number): RequestLog[] {
  if (!fs.existsSync(dir)) return [];
  const files = fs
    .readdirSync(dir)
    .filter((f) => FILE_RE.test(f))
    .sort()
    .reverse();
  const out: RequestLog[] = [];
  for (const f of files) {
    const lines = fs.readFileSync(path.join(dir, f), 'utf8').trim().split('\n').filter(Boolean).reverse();
    for (const line of lines) {
      try {
        out.push(JSON.parse(line) as RequestLog);
      } catch {
        /* skip */
      }
      if (out.length >= n) return out.reverse();
    }
  }
  return out.reverse();
}

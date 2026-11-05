import fs from 'node:fs';
import path from 'node:path';
import { claudeSettingsPath } from '../config/paths.js';
import { configExists, loadConfig } from '../config/store.js';
import type { Stats } from '../logs/store.js';
import { readState, type GuardStatus } from '../runtime.js';
import { formatStatusline } from '../statusline.js';
import { fetchStatus, guardUrl, isProcessAlive } from '../util/system.js';
import { banner, bar, c, sym, usageColor } from '../util/term.js';
import { formatTokens, formatUsd, untilIso } from '../util/format.js';
import { defaultConfig } from '../config/schema.js';

function serverAddr(): { host: string; port: number } {
  try {
    const cfg = configExists() ? loadConfig() : defaultConfig();
    return { host: cfg.server.host, port: cfg.server.port };
  } catch {
    const d = defaultConfig();
    return { host: d.server.host, port: d.server.port };
  }
}

export async function runStatus(opts: { json?: boolean }): Promise<void> {
  const { host, port } = serverAddr();
  const status = await fetchStatus(host, port, 1500);
  if (opts.json) {
    console.log(JSON.stringify(status ?? { running: false, lastKnown: readState().usage ?? null }, null, 2));
    return;
  }
  console.log(banner(status ? `v${status.version}` : undefined));
  if (!status) {
    console.log(`  ${sym.warn()} Not running. Start it with ${c.bold('ollama-guard start')} (or ${c.bold('start --detach')}).`);
    const last = readState().usage;
    if (last?.windows.length) {
      console.log(c.gray(`\n  Last known usage (${new Date(last.fetchedAt).toLocaleString()}):`));
      for (const w of last.windows)
        console.log(`  ${w.label.padEnd(16)} ${bar(w.used)} ${usageColor(w.used, `${Math.round(w.used * 100)}%`)}`);
    }
    console.log();
    return;
  }
  printStatus(status);
  try {
    const res = await fetch(`${guardUrl(host, port)}/api/guard/stats?days=1`, { signal: AbortSignal.timeout(1500) });
    const stats = (await res.json()) as Stats;
    const t = stats.totals;
    console.log(
      `\n  ${c.gray('Today        ')} ${t.requests} requests · ${formatTokens(t.inputTokens)} in · ${formatTokens(t.outputTokens)} out · ${formatUsd(t.costUsd)}${t.fallbacks ? c.magenta(` · ${t.fallbacks} via fallback`) : ''}`,
    );
  } catch {
    /* stats are optional */
  }
  console.log(`\n  ${c.gray('Dashboard    ')} ${c.cyan(`${guardUrl(host, port)}/dashboard`)}\n`);
}

export function printStatus(s: GuardStatus): void {
  console.log(
    `  ${c.gray('Account      ')} ${s.account.label}${s.account.scope === 'team' ? c.gray(' · team usage') : ''}${s.account.keyConfigured ? '' : c.yellow(' · no API key')}`,
  );
  const u = s.usage;
  if (u?.windows.length) {
    console.log();
    for (const w of u.windows) {
      const reset = untilIso(w.resetsAt);
      console.log(
        `  ${w.label.padEnd(13)} ${bar(w.used)} ${usageColor(w.used, `${String(Math.round(w.used * 100)).padStart(3)}%`)}${reset ? c.gray(`  resets in ${reset}`) : ''}`,
      );
    }
    if (u.purchasedUsd) console.log(`  ${c.gray('Extra credits')} ${formatUsd(u.purchasedUsd)}`);
  }
  if (u?.error) console.log(`\n  ${sym.warn()} ${u.error}`);
  const fb = s.fallback;
  console.log();
  if (fb.active)
    console.log(
      `  ${c.gray('Fallback     ')} ${c.magenta(`active → ${fb.provider ?? fb.chain[0]?.name}`)} ${c.gray(`(${fb.reason ?? ''}${fb.until ? `, retry Ollama in ${untilIso(fb.until)}` : ''})`)}`,
    );
  else
    console.log(
      `  ${c.gray('Fallback     ')} ${fb.enabled && fb.chain.length ? `ready · ${fb.chain.map((p) => p.name).join(' → ')}` : 'off'}`,
    );
  if (s.downgrade.enabled)
    console.log(
      `  ${c.gray('Downgrade    ')} ${s.downgrade.active ? c.cyan('active') : `at ${s.downgrade.thresholdPercent}%`}${s.downgrade.example ? c.gray(` · ${s.downgrade.example}`) : ''}`,
    );
}

// ------------------------------------------------------------ statusline

export async function runStatusline(opts: { color: boolean }): Promise<void> {
  const { host, port } = serverAddr();
  let status = await fetchStatus(host, port, 400);
  if (!status) {
    // The server may be busy; fall back to its last persisted state if fresh.
    const st = readState();
    if (st.pid && isProcessAlive(st.pid) && st.usage && Date.now() - Date.parse(st.usage.fetchedAt) < 5 * 60_000) {
      status = {
        version: '',
        startedAt: '',
        account: { label: '', scope: 'self', keyConfigured: true },
        usage: st.usage,
        fallback: {
          enabled: false,
          chain: [],
          active: Boolean(st.circuit?.open),
          provider: st.circuit?.provider,
          model: st.circuit?.model,
        },
        downgrade: { enabled: false, active: false, thresholdPercent: 90 },
        alerts: [],
        server: { host, port, requireToken: false },
      };
    }
  }
  process.stdout.write(`${formatStatusline(status, { color: opts.color })}\n`);
}

export function installStatusline(): string {
  const file = claudeSettingsPath();
  let settings: Record<string, unknown> = {};
  if (fs.existsSync(file)) {
    const text = fs.readFileSync(file, 'utf8');
    try {
      settings = JSON.parse(text) as Record<string, unknown>;
    } catch {
      throw new Error(`${file} is not valid JSON; fix it first.`);
    }
    fs.writeFileSync(`${file}.bak-ollama-guard`, text);
  }
  settings.statusLine = { type: 'command', command: 'ollama-guard statusline', padding: 0 };
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(settings, null, 2)}\n`);
  return file;
}

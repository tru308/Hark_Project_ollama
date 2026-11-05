import fs from 'node:fs';
import path from 'node:path';
import { claudeSettingsPath, paths } from '../config/paths.js';
import { defaultConfig, type GuardConfig, type Secrets } from '../config/schema.js';
import { configExists, loadConfig, loadSecrets, maskSecret, providerKey } from '../config/store.js';
import { OllamaApiError, OllamaUsageClient } from '../usage/client.js';
import { fetchStatus, guardUrl } from '../util/system.js';
import { banner, c, sym } from '../util/term.js';

type Level = 'ok' | 'warn' | 'fail' | 'info';
interface Check {
  level: Level;
  title: string;
  detail?: string;
  fix?: string;
}

const icon = (l: Level) => (l === 'ok' ? sym.ok() : l === 'warn' ? sym.warn() : l === 'fail' ? sym.fail() : sym.info());

function print(section: string, checks: Check[]): void {
  console.log(`\n  ${c.bold(section)}`);
  for (const ch of checks) {
    console.log(`  ${icon(ch.level)} ${ch.title}${ch.detail ? c.gray(`  ${ch.detail}`) : ''}`);
    if (ch.fix && ch.level !== 'ok') console.log(`      ${c.gray('→')} ${ch.fix}`);
  }
}

function onPath(cmd: string): string | undefined {
  const exts = process.platform === 'win32' ? (process.env.PATHEXT ?? '.EXE;.CMD;.BAT').split(';') : [''];
  for (const dir of (process.env.PATH ?? '').split(path.delimiter)) {
    for (const ext of exts) {
      const p = path.join(dir, cmd + ext.toLowerCase());
      const P = path.join(dir, cmd + ext);
      if (fs.existsSync(p)) return p;
      if (fs.existsSync(P)) return P;
    }
  }
  return undefined;
}

export async function runDoctor(): Promise<number> {
  console.log(banner('doctor'));
  let failures = 0;
  const tally = (cs: Check[]) => {
    failures += cs.filter((x) => x.level === 'fail').length;
    return cs;
  };

  // --- Environment
  const env: Check[] = [];
  const [maj = 0, min = 0] = process.versions.node.split('.').map(Number);
  env.push(
    maj > 20 || (maj === 20 && min >= 10)
      ? { level: 'ok', title: `Node.js ${process.versions.node}` }
      : { level: 'fail', title: `Node.js ${process.versions.node}`, fix: 'Install Node.js 20 LTS or newer from nodejs.org' },
  );
  env.push({ level: 'info', title: `Platform ${process.platform} ${process.arch}`, detail: paths.home });

  let cfg: GuardConfig = defaultConfig();
  if (!configExists()) env.push({ level: 'warn', title: 'No config yet', fix: 'Run `ollama-guard init`' });
  else {
    try {
      cfg = loadConfig();
      env.push({ level: 'ok', title: 'Config is valid', detail: paths.config });
    } catch (err) {
      env.push({ level: 'fail', title: 'Config has problems', detail: (err as Error).message.replace(/\n/g, ' ') });
    }
  }
  print('Environment', tally(env));

  // --- Ollama account
  const secrets: Secrets = await loadSecrets(cfg);
  const acct: Check[] = [];
  if (!secrets.ollamaApiKey)
    acct.push({
      level: 'fail',
      title: 'No Ollama API key',
      fix: 'Run `ollama-guard init`, or set OLLAMA_API_KEY. Create a key at https://ollama.com/settings/keys',
    });
  else {
    acct.push({
      level: 'ok',
      title: 'API key present',
      detail: `${maskSecret(secrets.ollamaApiKey)} (${process.env.OLLAMA_API_KEY ? 'from OLLAMA_API_KEY' : cfg.secretStore})`,
    });
    try {
      const res = await fetch(new URL('/api/tags', cfg.ollama.baseUrl), { signal: AbortSignal.timeout(8000) });
      acct.push(
        res.ok
          ? { level: 'ok', title: `Reached ${cfg.ollama.baseUrl}` }
          : { level: 'warn', title: `${cfg.ollama.baseUrl} answered ${res.status}` },
      );
    } catch (err) {
      acct.push({
        level: 'fail',
        title: `Cannot reach ${cfg.ollama.baseUrl}`,
        detail: (err as Error).message,
        fix: 'Check your internet connection, VPN or proxy',
      });
    }
    const client = new OllamaUsageClient({
      baseUrl: cfg.ollama.baseUrl,
      apiKey: secrets.ollamaApiKey,
      scope: cfg.ollama.usageScope,
      timeoutMs: 8000,
    });
    try {
      await client.balance();
      acct.push({ level: 'ok', title: 'Key accepted by /api/balance' });
    } catch (err) {
      const e = err as OllamaApiError;
      acct.push(
        e.status === 401
          ? {
              level: 'fail',
              title: 'Ollama rejected the key (401)',
              fix: 'Create a new key at https://ollama.com/settings/keys and rerun `ollama-guard init`',
            }
          : { level: 'warn', title: '/api/balance failed', detail: e.message },
      );
    }
    try {
      await client.usage('24h');
      acct.push({ level: 'ok', title: `Usage API works (scope: ${cfg.ollama.usageScope})` });
    } catch (err) {
      const e = err as OllamaApiError;
      acct.push({
        level: 'warn',
        title: '/api/usage failed',
        detail: e.message,
        fix:
          cfg.ollama.usageScope === 'team' && e.status === 403
            ? 'Team scope needs a team admin; set ollama.usageScope to "self"'
            : undefined,
      });
    }
  }
  print('Ollama account', tally(acct));

  // --- Proxy
  const url = guardUrl(cfg.server.host, cfg.server.port);
  const proxy: Check[] = [];
  const running = await fetchStatus(cfg.server.host, cfg.server.port, 1500);
  proxy.push(
    running
      ? { level: 'ok', title: `Guard running at ${url}`, detail: `v${running.version}` }
      : { level: 'warn', title: `Guard not running on ${url}`, fix: 'Run `ollama-guard start` (or `start --detach`)' },
  );
  print('Proxy', tally(proxy));

  // --- Claude Code
  const cc: Check[] = [];
  const claudeBin = onPath('claude');
  cc.push(
    claudeBin
      ? { level: 'ok', title: 'Claude Code found', detail: claudeBin }
      : { level: 'warn', title: 'Claude Code (`claude`) not on PATH', fix: 'Install: https://code.claude.com/docs/en/overview' },
  );
  const base = process.env.ANTHROPIC_BASE_URL;
  const settingsFile = claudeSettingsPath();
  let settings: { env?: Record<string, string>; statusLine?: { command?: string } } = {};
  try {
    settings = JSON.parse(fs.readFileSync(settingsFile, 'utf8')) as typeof settings;
  } catch {
    /* none */
  }
  const settingsBase = settings.env?.ANTHROPIC_BASE_URL;
  const norm = (u?: string) => (u ?? '').replace(/\/+$/, '').replace('localhost', '127.0.0.1');
  if (settingsBase) {
    cc.push(
      norm(settingsBase) === norm(url)
        ? { level: 'ok', title: '~/.claude/settings.json points at the guard' }
        : {
            level: 'warn',
            title: `~/.claude/settings.json sets ANTHROPIC_BASE_URL=${settingsBase}`,
            detail: 'settings override your shell',
            fix: `Change it to ${url} (see \`ollama-guard env --claude-json\`)`,
          },
    );
  } else if (base) {
    cc.push(
      norm(base) === norm(url)
        ? { level: 'ok', title: 'ANTHROPIC_BASE_URL points at the guard (this shell)' }
        : { level: 'warn', title: `ANTHROPIC_BASE_URL is ${base}`, fix: 'Run `ollama-guard env` and apply the output' },
    );
  } else
    cc.push({
      level: 'warn',
      title: 'ANTHROPIC_BASE_URL is not set in this shell',
      fix: 'Run `ollama-guard env` (or add it to ~/.claude/settings.json with `env --claude-json`)',
    });
  const apiKey = settings.env?.ANTHROPIC_API_KEY ?? process.env.ANTHROPIC_API_KEY;
  if (apiKey)
    cc.push({
      level: 'warn',
      title: 'ANTHROPIC_API_KEY is set',
      detail: 'Claude Code may prefer it',
      fix: 'Set ANTHROPIC_API_KEY to an empty string',
    });
  if (cfg.server.requireToken) {
    const tok = settings.env?.ANTHROPIC_AUTH_TOKEN ?? process.env.ANTHROPIC_AUTH_TOKEN;
    cc.push(
      tok === secrets.proxyToken
        ? { level: 'ok', title: 'Proxy token matches' }
        : { level: 'warn', title: 'requireToken is on but ANTHROPIC_AUTH_TOKEN does not match', fix: 'Run `ollama-guard env`' },
    );
  }
  cc.push(
    settings.statusLine?.command?.includes('ollama-guard')
      ? { level: 'ok', title: 'Status line installed' }
      : { level: 'info', title: 'Status line not installed', detail: 'optional: `ollama-guard statusline --install`' },
  );
  print('Claude Code', tally(cc));

  // --- Fallback
  const fb: Check[] = [];
  if (!cfg.fallback.enabled || !cfg.fallback.chain.length)
    fb.push({ level: 'info', title: 'Fallback is off', detail: "requests fail with Ollama's error when you hit a limit" });
  for (const p of cfg.fallback.chain.filter((x) => x.enabled !== false)) {
    if (p.type === 'ollama-local') {
      const baseUrl = p.baseUrl ?? 'http://localhost:11434';
      try {
        const res = await fetch(`${baseUrl}/api/tags`, { signal: AbortSignal.timeout(3000) });
        const j = (await res.json()) as { models?: Array<{ name: string }> };
        const names = (j.models ?? []).map((m) => m.name);
        const want = p.defaultModel;
        if (want && !names.some((n) => n === want || n === `${want}:latest`))
          fb.push({ level: 'warn', title: `${p.name}: local Ollama is up but "${want}" is not pulled`, fix: `ollama pull ${want}` });
        else fb.push({ level: 'ok', title: `${p.name}: local Ollama reachable`, detail: `${names.length} models` });
      } catch {
        fb.push({
          level: 'warn',
          title: `${p.name}: local Ollama not reachable at ${baseUrl}`,
          fix: 'Start the Ollama app, or run `ollama serve`',
        });
      }
    } else {
      const key = providerKey(secrets, p.name, p.apiKeyEnv);
      fb.push(
        key
          ? { level: 'ok', title: `${p.name} (${p.type}) key present`, detail: maskSecret(key) }
          : {
              level: 'fail',
              title: `${p.name} (${p.type}) has no API key`,
              fix: 'Add it in the dashboard settings or rerun `ollama-guard init`',
            },
      );
    }
  }
  print('Fallback', tally(fb));

  // --- Alerts & security
  const al: Check[] = [];
  al.push({
    level: 'info',
    title: `Thresholds ${cfg.alerts.thresholds.join('/')}%`,
    detail:
      [cfg.alerts.desktop && 'desktop', cfg.alerts.telegram.enabled && 'telegram', cfg.alerts.discord.enabled && 'discord']
        .filter(Boolean)
        .join(', ') || 'no channels',
  });
  if (cfg.alerts.telegram.enabled && (!secrets.telegramBotToken || !cfg.alerts.telegram.chatId))
    al.push({ level: 'fail', title: 'Telegram enabled but token/chat id missing', fix: 'Rerun `ollama-guard init`' });
  if (cfg.alerts.discord.enabled && !secrets.discordWebhookUrl) al.push({ level: 'fail', title: 'Discord enabled but webhook missing' });
  if (process.platform !== 'win32' && fs.existsSync(paths.secrets)) {
    const mode = fs.statSync(paths.secrets).mode & 0o777;
    al.push(
      mode & 0o077
        ? { level: 'warn', title: `secrets.json is readable by others (${mode.toString(8)})`, fix: `chmod 600 ${paths.secrets}` }
        : { level: 'ok', title: 'secrets.json is private (600)' },
    );
  }
  print('Alerts & security', tally(al));

  console.log(failures ? `\n  ${sym.fail()} ${failures} problem${failures > 1 ? 's' : ''} found.\n` : `\n  ${sym.ok()} All good.\n`);
  return failures ? 1 : 0;
}

import fs from 'node:fs';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { paths } from '../config/paths.js';
import { ensureHome, loadConfig, loadSecrets, saveConfig, saveSecrets } from '../config/store.js';
import { GuardRuntime } from '../runtime.js';
import { createGuardServer } from '../server.js';
import { fetchStatus, guardUrl, isProcessAlive, openInBrowser } from '../util/system.js';
import { banner, c, log, sym } from '../util/term.js';
import { formatDuration } from '../util/format.js';
import { VERSION } from '../version.js';

export interface StartOptions {
  port?: number;
  host?: string;
  detach?: boolean;
  open?: boolean;
}

export async function runStart(opts: StartOptions): Promise<void> {
  ensureHome();
  const cfg = loadConfig();
  if (opts.port) cfg.server.port = opts.port;
  if (opts.host) cfg.server.host = opts.host;
  const url = guardUrl(cfg.server.host, cfg.server.port);

  const existing = await fetchStatus(cfg.server.host, cfg.server.port);
  if (existing) {
    console.log(`${sym.info()} Ollama Guard is already running at ${c.cyan(url)} ${c.gray(`(v${existing.version})`)}`);
    if (opts.open) openInBrowser(`${url}/dashboard`);
    return;
  }

  if (opts.detach) return detach(opts, url);

  const secrets = await loadSecrets(cfg);
  const rt = new GuardRuntime(cfg, secrets);
  const server = createGuardServer(rt, {
    saveConfig: (next) => saveConfig(next),
    saveSecrets: async (next) => {
      await saveSecrets(rt.config, next);
    },
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', (err: NodeJS.ErrnoException) => {
      if (err.code === 'EADDRINUSE')
        reject(new Error(`Port ${cfg.server.port} is busy. Try \`ollama-guard start --port ${cfg.server.port + 1}\`.`));
      else reject(err);
    });
    server.listen(cfg.server.port, cfg.server.host, () => resolve());
  });
  rt.start();
  fs.writeFileSync(paths.pid, String(process.pid));

  console.log(banner(`v${VERSION}`));
  console.log(`  ${c.gray('Proxy      ')} ${c.cyan(url)}`);
  console.log(`  ${c.gray('Dashboard  ')} ${c.cyan(`${url}/dashboard`)}`);
  console.log(`  ${c.gray('Account    ')} ${cfg.ollama.accountLabel}${cfg.ollama.usageScope === 'team' ? c.gray(' (team usage)') : ''}`);
  console.log(
    `  ${c.gray('Fallback   ')} ${
      cfg.fallback.enabled && cfg.fallback.chain.length
        ? cfg.fallback.chain
            .filter((p) => p.enabled !== false)
            .map((p) => p.name)
            .join(' → ')
        : 'off'
    }`,
  );
  if (!secrets.ollamaApiKey) console.log(`\n  ${sym.warn()} No Ollama API key yet. Run ${c.bold('ollama-guard init')}.`);
  console.log(`\n  ${c.gray('Point Claude Code here:')} ${c.bold('ollama-guard env')}   ${c.gray('Stop with Ctrl+C')}\n`);

  rt.on('request', (e) => {
    const tokens = e.inputTokens + e.outputTokens ? c.gray(` ${e.inputTokens}→${e.outputTokens} tok`) : '';
    const via = e.provider === 'ollama-cloud' ? '' : c.magenta(` via ${e.provider}`);
    const line = `${e.status < 400 ? sym.ok() : sym.fail()} ${e.status} ${e.model ?? e.requestedModel ?? '?'}${via}${tokens} ${c.gray(`${e.latencyMs}ms · ${e.project}`)}`;
    console.log(`${c.gray(new Date().toTimeString().slice(0, 8))} ${line}`);
  });
  rt.on('alert', (a) => log.warn(`${c.bold(a.title)}: ${a.message}`));
  let lastErr: string | undefined;
  rt.poller.on('update', (s) => {
    if (s.error && s.error !== lastErr) log.warn(s.error);
    lastErr = s.error;
    if (s.headline && !s.error) {
      const reset = s.headline.resetsAt ? ` · resets ${formatDuration(Date.parse(s.headline.resetsAt) - Date.now())}` : '';
      log.info(`Usage ${s.windows.map((w) => `${w.label.toLowerCase()} ${Math.round(w.used * 100)}%`).join(' · ')}${c.gray(reset)}`);
    }
  });

  if (opts.open) openInBrowser(`${url}/dashboard`);

  const shutdown = () => {
    log.info('Shutting down…');
    rt.stop();
    server.close();
    try {
      if (fs.readFileSync(paths.pid, 'utf8').trim() === String(process.pid)) fs.rmSync(paths.pid);
    } catch {
      /* ignore */
    }
    setTimeout(() => process.exit(0), 300).unref();
  };
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
}

async function detach(opts: StartOptions, url: string): Promise<void> {
  const cli = fileURLToPath(new URL('../cli.js', import.meta.url));
  const args = [cli, 'start'];
  if (opts.port) args.push('--port', String(opts.port));
  if (opts.host) args.push('--host', opts.host);
  const out = fs.openSync(paths.daemonLog, 'a');
  const child = spawn(process.execPath, args, {
    detached: true,
    stdio: ['ignore', out, out],
    windowsHide: true,
    env: { ...withoutForceColor(process.env), NO_COLOR: '1' },
  });
  child.unref();
  const port = Number(new URL(url).port);
  const host = new URL(url).hostname;
  for (let i = 0; i < 40; i++) {
    await new Promise((r) => setTimeout(r, 150));
    if (await fetchStatus(host, port, 300)) {
      console.log(`${sym.ok()} Ollama Guard running in the background at ${c.cyan(url)} ${c.gray(`(pid ${child.pid})`)}`);
      console.log(
        `  ${c.gray('Dashboard')} ${c.cyan(`${url}/dashboard`)}   ${c.gray('Logs')} ${paths.daemonLog}   ${c.gray('Stop')} ollama-guard stop`,
      );
      if (opts.open) openInBrowser(`${url}/dashboard`);
      return;
    }
    if (child.pid && !isProcessAlive(child.pid)) break;
  }
  throw new Error(`Ollama Guard did not start. See ${paths.daemonLog}`);
}

export async function runStop(): Promise<void> {
  let pid: number | undefined;
  try {
    pid = Number(fs.readFileSync(paths.pid, 'utf8').trim());
  } catch {
    /* no pid file */
  }
  if (!pid || !isProcessAlive(pid)) {
    console.log(`${sym.info()} Ollama Guard is not running.`);
    return;
  }
  process.kill(pid, 'SIGTERM');
  for (let i = 0; i < 20 && isProcessAlive(pid); i++) await new Promise((r) => setTimeout(r, 100));
  try {
    fs.rmSync(paths.pid);
  } catch {
    /* ignore */
  }
  console.log(`${sym.ok()} Stopped Ollama Guard ${c.gray(`(pid ${pid})`)}`);
}

function withoutForceColor(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const copy = { ...env };
  delete copy.FORCE_COLOR;
  return copy;
}

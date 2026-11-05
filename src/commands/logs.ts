import { paths } from '../config/paths.js';
import { configExists, loadConfig } from '../config/store.js';
import { defaultConfig } from '../config/schema.js';
import { tailLogs, type RequestLog } from '../logs/store.js';
import { guardUrl } from '../util/system.js';
import { c, sym } from '../util/term.js';

export function formatLogLine(e: RequestLog): string {
  const time = new Date(e.ts).toLocaleTimeString([], { hour12: false });
  const status = e.status < 400 ? c.green(String(e.status)) : c.red(String(e.status));
  const via = e.provider === 'ollama-cloud' ? c.gray('cloud') : c.magenta(e.provider);
  const model = e.model ?? e.requestedModel ?? '?';
  const tok = `${e.inputTokens}→${e.outputTokens}`;
  const extra = [e.downgraded ? c.cyan('downgraded') : '', e.fallback ? c.magenta(e.fallback) : '', e.error ? c.red(e.error) : '']
    .filter(Boolean)
    .join(' ');
  return `${c.gray(time)} ${status} ${via.padEnd(12)} ${model.padEnd(18)} ${c.gray(tok.padEnd(14))} ${String(e.latencyMs).padStart(6)}ms ${c.gray(e.project)} ${extra}`.trimEnd();
}

export async function runLogs(opts: { n: number; follow: boolean; json: boolean }): Promise<void> {
  const entries = tailLogs(paths.logsDir, opts.n);
  if (!entries.length && !opts.follow) {
    console.log(`${sym.info()} No requests logged yet.`);
    return;
  }
  for (const e of entries) console.log(opts.json ? JSON.stringify(e) : formatLogLine(e));
  if (!opts.follow) return;

  const cfg = configExists() ? loadConfig() : defaultConfig();
  const url = `${guardUrl(cfg.server.host, cfg.server.port)}/api/guard/events`;
  let res: Response;
  try {
    res = await fetch(url);
  } catch {
    console.error(`${sym.warn()} Ollama Guard is not running, so there is nothing to follow.`);
    process.exitCode = 1;
    return;
  }
  if (!opts.json) console.log(c.gray('— following live requests (Ctrl+C to stop) —'));
  const reader = res.body!.getReader();
  const dec = new TextDecoder();
  let buf = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let i: number;
    while ((i = buf.indexOf('\n\n')) !== -1) {
      const block = buf.slice(0, i);
      buf = buf.slice(i + 2);
      if (!block.startsWith('event: request')) continue;
      const data = block.split('\n').find((l) => l.startsWith('data: '));
      if (!data) continue;
      const e = JSON.parse(data.slice(6)) as RequestLog;
      console.log(opts.json ? JSON.stringify(e) : formatLogLine(e));
    }
  }
}

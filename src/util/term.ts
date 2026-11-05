/* Tiny dependency-free terminal styling that respects NO_COLOR and non-TTY output. */

const enabled = (): boolean => !process.env.NO_COLOR && (Boolean(process.env.FORCE_COLOR) || Boolean(process.stdout.isTTY));

const wrap = (open: number, close: number) => (s: string) => (enabled() ? `\x1b[${open}m${s}\x1b[${close}m` : s);

export const c = {
  bold: wrap(1, 22),
  dim: wrap(2, 22),
  red: wrap(31, 39),
  green: wrap(32, 39),
  yellow: wrap(33, 39),
  blue: wrap(34, 39),
  magenta: wrap(35, 39),
  cyan: wrap(36, 39),
  gray: wrap(90, 39),
};

export const sym = {
  ok: () => c.green('✔'),
  fail: () => c.red('✖'),
  warn: () => c.yellow('▲'),
  info: () => c.blue('●'),
  arrow: () => c.gray('›'),
};

export function banner(subtitle?: string): string {
  const title = `${c.bold('Ollama Guard')}`;
  return subtitle ? `\n  ${title}  ${c.gray(subtitle)}\n` : `\n  ${title}\n`;
}

/** Colour a usage fraction green / yellow / red. */
export function usageColor(fraction: number, s: string): string {
  if (fraction >= 0.9) return c.red(s);
  if (fraction >= 0.7) return c.yellow(s);
  return c.green(s);
}

export function bar(fraction: number, width = 24): string {
  const f = Math.max(0, Math.min(1, fraction));
  const full = Math.round(f * width);
  return usageColor(f, '█'.repeat(full)) + c.gray('░'.repeat(width - full));
}

/** Minimal timestamped logger for the server process. */
export const log = {
  info: (msg: string) => console.log(`${c.gray(time())} ${sym.info()} ${msg}`),
  ok: (msg: string) => console.log(`${c.gray(time())} ${sym.ok()} ${msg}`),
  warn: (msg: string) => console.warn(`${c.gray(time())} ${sym.warn()} ${msg}`),
  error: (msg: string) => console.error(`${c.gray(time())} ${sym.fail()} ${msg}`),
};

function time(): string {
  return new Date().toTimeString().slice(0, 8);
}

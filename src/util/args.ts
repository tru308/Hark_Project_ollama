/** Minimal argv parser: commands, --flags, --key=value, --no-flag and short aliases. */
export interface Parsed {
  cmd: string;
  positional: string[];
  flags: Record<string, string | boolean>;
}

export function parseArgs(argv: string[]): Parsed {
  const flags: Record<string, string | boolean> = {};
  const positional: string[] = [];
  const valueFlags = new Set(['port', 'host', 'shell', 'n', 'lines']);
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i] as string;
    if (a === '--') {
      positional.push(...argv.slice(i + 1));
      break;
    }
    if (a.startsWith('--')) {
      const [k, v] = a.slice(2).split('=', 2) as [string, string | undefined];
      if (k.startsWith('no-')) flags[k.slice(3)] = false;
      else if (v !== undefined) flags[k] = v;
      else if (valueFlags.has(k) && argv[i + 1] && !argv[i + 1]!.startsWith('-')) flags[k] = argv[++i] as string;
      else flags[k] = true;
    } else if (/^-[a-zA-Z]$/.test(a)) {
      const k = a.slice(1);
      const alias: Record<string, string> = { n: 'n', f: 'follow', y: 'yes', h: 'help', v: 'version', p: 'port' };
      const name = alias[k] ?? k;
      if (valueFlags.has(name) && argv[i + 1]) flags[name] = argv[++i] as string;
      else flags[name] = true;
    } else positional.push(a);
  }
  return { cmd: positional.shift() ?? '', positional, flags };
}

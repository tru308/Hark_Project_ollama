import path from 'node:path';
import type { GuardConfig, Secrets } from '../config/schema.js';
import { guardUrl } from '../util/system.js';
import { c } from '../util/term.js';

export type ShellKind = 'bash' | 'zsh' | 'fish' | 'powershell' | 'cmd';

export function detectShell(): ShellKind {
  if (process.platform === 'win32') {
    // cmd.exe sets PROMPT (e.g. $P$G); PowerShell does not. Default to PowerShell.
    return process.env.PROMPT ? 'cmd' : 'powershell';
  }
  const sh = path.basename(process.env.SHELL ?? 'bash');
  if (sh === 'zsh' || sh === 'fish') return sh;
  return 'bash';
}

export function claudeEnvVars(cfg: GuardConfig, secrets: Secrets): Record<string, string> {
  return {
    ANTHROPIC_BASE_URL: guardUrl(cfg.server.host, cfg.server.port),
    // Claude Code needs *some* token. The guard swaps in your real Ollama key upstream.
    ANTHROPIC_AUTH_TOKEN: cfg.server.requireToken && secrets.proxyToken ? secrets.proxyToken : 'ollama-guard',
    // An empty API key stops Claude Code from preferring an old Anthropic key.
    ANTHROPIC_API_KEY: '',
  };
}

export function renderEnv(vars: Record<string, string>, shell: ShellKind): string {
  const q = (v: string) => v.replace(/"/g, '\\"');
  const lines: string[] = [];
  switch (shell) {
    case 'powershell':
      for (const [k, v] of Object.entries(vars)) lines.push(`$env:${k} = "${v.replace(/`/g, '``').replace(/"/g, '`"')}"`);
      break;
    case 'cmd':
      for (const [k, v] of Object.entries(vars)) lines.push(v ? `set "${k}=${v}"` : `set "${k}="`);
      break;
    case 'fish':
      for (const [k, v] of Object.entries(vars)) lines.push(`set -gx ${k} "${q(v)}"`);
      break;
    default:
      for (const [k, v] of Object.entries(vars)) lines.push(`export ${k}="${q(v)}"`);
  }
  return lines.join('\n');
}

export function persistHint(vars: Record<string, string>, shell: ShellKind): string {
  switch (shell) {
    case 'powershell':
      return Object.entries(vars)
        .map(([k, v]) => `[Environment]::SetEnvironmentVariable("${k}", ${v ? `"${v}"` : '$null'}, "User")`)
        .join('\n');
    case 'cmd':
      return Object.entries(vars)
        .filter(([, v]) => v)
        .map(([k, v]) => `setx ${k} "${v}"`)
        .join('\n');
    case 'fish':
      return `ollama-guard env --shell fish >> ~/.config/fish/config.fish`;
    case 'zsh':
      return `ollama-guard env --shell zsh >> ~/.zshrc`;
    default:
      return `ollama-guard env --shell bash >> ~/.bashrc`;
  }
}

export function runEnv(cfg: GuardConfig, secrets: Secrets, opts: { shell?: string; claudeJson?: boolean; quiet?: boolean }): void {
  const vars = claudeEnvVars(cfg, secrets);
  if (opts.claudeJson) {
    console.log(JSON.stringify({ env: vars }, null, 2));
    if (!opts.quiet)
      console.error(c.gray('\n# Paste the "env" block into ~/.claude/settings.json to apply it on every OS without touching your shell.'));
    return;
  }
  const shell = (opts.shell as ShellKind | undefined) ?? detectShell();
  if (!['bash', 'zsh', 'fish', 'powershell', 'cmd'].includes(shell)) {
    throw new Error(`Unknown shell "${shell}". Use bash, zsh, fish, powershell or cmd.`);
  }
  console.log(renderEnv(vars, shell));
  if (!opts.quiet && process.stdout.isTTY) {
    console.log(c.gray(`\n# ${shell}: run the lines above in this terminal, then start \`claude\`.`));
    console.log(c.gray('# To make it permanent:'));
    for (const l of persistHint(vars, shell).split('\n')) console.log(c.gray(`#   ${l}`));
  }
}

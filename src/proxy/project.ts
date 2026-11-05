import path from 'node:path';

/**
 * Work out which project a request belongs to, for per-project stats.
 *  1. An explicit `x-ollama-guard-project` header (set via ANTHROPIC_CUSTOM_HEADERS).
 *  2. Claude Code's system prompt, which includes "Working directory: /path".
 *  3. "unknown".
 */
export function detectProject(headers: Record<string, string | string[] | undefined>, body: unknown): string {
  const h = headers['x-ollama-guard-project'];
  const header = Array.isArray(h) ? h[0] : h;
  if (header && header.trim()) return header.trim().slice(0, 80);

  const system = (body as { system?: unknown } | undefined)?.system;
  const text =
    typeof system === 'string' ? system : Array.isArray(system) ? system.map((b) => (b as { text?: string })?.text ?? '').join('\n') : '';
  const m = /(?:Working directory|Primary working directory|cwd):\s*([^\n\r]+)/i.exec(text);
  if (m && m[1]) {
    const dir = m[1].trim().replace(/[\\/]+$/, '');
    const base = dir.split(/[\\/]/).pop() || path.basename(dir);
    if (base) return base.slice(0, 80);
  }
  return 'unknown';
}

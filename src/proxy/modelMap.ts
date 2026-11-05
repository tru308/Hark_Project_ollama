/**
 * Glob-style model mapping. Patterns support `*` (any run of characters).
 * Exact keys win; otherwise the most specific (longest literal) pattern wins.
 *
 *   mapModel("claude-haiku-4-5", { "claude-*haiku*": "glm-5.3-flash", "claude-*": "glm-5.3" })
 *     → "glm-5.3-flash"
 */
export function globToRegExp(pattern: string): RegExp {
  const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*');
  return new RegExp(`^${escaped}$`, 'i');
}

export function matchModel(model: string, map: Record<string, string> | undefined): string | undefined {
  if (!map || !model) return undefined;
  if (Object.prototype.hasOwnProperty.call(map, model)) return map[model];
  let best: { score: number; value: string } | undefined;
  for (const [pattern, value] of Object.entries(map)) {
    if (!pattern.includes('*')) continue;
    if (!globToRegExp(pattern).test(model)) continue;
    const score = pattern.replace(/\*/g, '').length;
    if (!best || score > best.score) best = { score, value };
  }
  return best?.value;
}

export function mapModel(model: string, map: Record<string, string> | undefined, fallback?: string): string {
  return matchModel(model, map) ?? fallback ?? model;
}

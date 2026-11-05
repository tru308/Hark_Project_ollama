import { PROVIDER_DEFAULTS, type GuardConfig, type Pricing, type Secrets } from '../config/schema.js';
import { providerKey } from '../config/store.js';
import { mapModel, matchModel } from './modelMap.js';

export const PRIMARY_NAME = 'ollama-cloud';

export interface Target {
  name: string;
  kind: 'primary' | 'fallback';
  baseUrl: string;
  /** Auth headers to set on the upstream request. */
  auth: Record<string, string>;
  model: string;
  downgraded?: boolean;
}

export interface PlanState {
  /** Fraction used of the tightest usage window, if known. */
  headlineUsed?: number;
  /** True while Ollama Cloud is known to be limited (after a limit error). */
  circuitOpen: boolean;
}

export interface Plan {
  attempts: Target[];
  /** Why the primary was skipped or moved last, if it was. */
  primarySkipped?: string;
}

export function primaryTarget(requestedModel: string, cfg: GuardConfig, secrets: Secrets, state: PlanState): Target {
  let model = mapModel(requestedModel, cfg.models.map);
  let downgraded = false;
  if (cfg.downgrade.enabled && state.headlineUsed !== undefined && state.headlineUsed * 100 >= cfg.downgrade.thresholdPercent) {
    const cheaper = matchModel(model, cfg.downgrade.map) ?? matchModel(requestedModel, cfg.downgrade.map);
    if (cheaper && cheaper !== model) {
      model = cheaper;
      downgraded = true;
    }
  }
  const auth: Record<string, string> = {};
  if (secrets.ollamaApiKey) auth.authorization = `Bearer ${secrets.ollamaApiKey}`;
  return { name: PRIMARY_NAME, kind: 'primary', baseUrl: cfg.ollama.baseUrl, auth, model, downgraded };
}

export function fallbackTargets(requestedModel: string, cfg: GuardConfig, secrets: Secrets): Target[] {
  return cfg.fallback.chain
    .filter((p) => p.enabled !== false)
    .map((p) => {
      const defaults = PROVIDER_DEFAULTS[p.type];
      const style = p.authStyle ?? defaults.authStyle;
      const key = providerKey(secrets, p.name, p.apiKeyEnv);
      const auth: Record<string, string> = {};
      if (style === 'bearer' && key) auth.authorization = `Bearer ${key}`;
      if (style === 'x-api-key' && key) auth['x-api-key'] = key;
      if (style === 'none' && p.type === 'ollama-local') auth['x-api-key'] = 'ollama';
      return {
        name: p.name,
        kind: 'fallback' as const,
        baseUrl: p.baseUrl || defaults.baseUrl,
        auth,
        model: mapModel(requestedModel, p.modelMap, p.defaultModel),
      };
    });
}

/**
 * Build the ordered list of upstreams to try for one request.
 *  - Normal: [Ollama Cloud, ...fallback chain]
 *  - Ollama known to be limited (circuit open): [...fallback chain, Ollama Cloud]
 *  - Fallback disabled: [Ollama Cloud]
 */
export function planAttempts(requestedModel: string, cfg: GuardConfig, secrets: Secrets, state: PlanState): Plan {
  const primary = primaryTarget(requestedModel, cfg, secrets, state);
  if (!cfg.fallback.enabled) return { attempts: [primary] };
  const fallbacks = fallbackTargets(requestedModel, cfg, secrets);
  if (fallbacks.length === 0) return { attempts: [primary] };
  if (state.circuitOpen) return { attempts: [...fallbacks, primary], primarySkipped: 'limit reached' };
  return { attempts: [primary, ...fallbacks] };
}

/**
 * Estimate cost in USD. Pricing keys are a model glob ("glm-5.3*") or a
 * provider-scoped glob using "::" ("openrouter::anthropic/*"). Explicit pricing
 * wins; then Ollama's own per-model rates from the usage API; otherwise 0.
 */
export function estimateCost(
  provider: string,
  model: string | undefined,
  inputTokens: number,
  outputTokens: number,
  pricing: Record<string, Pricing>,
  ratePerToken?: Record<string, number>,
): number {
  if (!model) return 0;
  const scoped: Record<string, string> = {};
  const unscoped: Record<string, string> = {};
  for (const k of Object.keys(pricing)) (k.includes('::') ? scoped : unscoped)[k] = k;
  const hit = matchModel(`${provider}::${model}`, scoped) ?? matchModel(model, unscoped);
  const price = hit ? pricing[hit] : undefined;
  if (price) return (inputTokens * price.inputPerMTok + outputTokens * price.outputPerMTok) / 1_000_000;
  if (provider === PRIMARY_NAME && ratePerToken) {
    const rate = ratePerToken[model];
    if (rate) return (inputTokens + outputTokens) * rate;
  }
  return 0;
}

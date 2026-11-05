/**
 * Configuration model for Ollama Guard.
 *
 * Design rule (deliberate, see README "One account"): the primary upstream is
 * exactly ONE Ollama account, reached with ONE API key. There is no list of
 * Ollama keys and no rotation. Fallback targets are different, legitimate
 * services the user pays for or runs themselves (local Ollama, OpenRouter,
 * Anthropic, or any Anthropic-compatible gateway with the user's own key).
 */

export type ProviderType = 'ollama-local' | 'anthropic' | 'openrouter' | 'anthropic-compatible';
export type AuthStyle = 'bearer' | 'x-api-key' | 'none';

export interface FallbackProvider {
  /** Unique, human friendly name, e.g. "local" or "openrouter". */
  name: string;
  type: ProviderType;
  enabled?: boolean;
  /** Override the base URL (defaults depend on type). */
  baseUrl?: string;
  authStyle?: AuthStyle;
  /** Read the key from this environment variable instead of the secret store. */
  apiKeyEnv?: string;
  /** Glob map from requested model to this provider's model id. */
  modelMap?: Record<string, string>;
  /** Model used when no modelMap entry matches. */
  defaultModel?: string;
}

export interface Pricing {
  /** USD per million input tokens. */
  inputPerMTok: number;
  /** USD per million output tokens. */
  outputPerMTok: number;
}

export interface GuardConfig {
  version: 1;
  server: {
    host: string;
    port: number;
    /** When true, Claude Code must send the proxy token as ANTHROPIC_AUTH_TOKEN. */
    requireToken: boolean;
    /** Answer /v1/messages/count_tokens locally (Ollama does not implement it). */
    localCountTokens: boolean;
  };
  ollama: {
    baseUrl: string;
    /** Display label for the single account ("personal" or your team's name). */
    accountLabel: string;
    /** "team" shows team-wide usage history; requires team admin. Same single key. */
    usageScope: 'self' | 'team';
    /** Poll interval for /api/usage and /api/balance. Docs recommend 60s. */
    pollIntervalSec: number;
    requestTimeoutSec: number;
  };
  models: {
    /** Glob map applied to requests going to Ollama Cloud, e.g. {"claude-*": "glm-5.3"}. */
    map: Record<string, string>;
  };
  fallback: {
    enabled: boolean;
    /** HTTP statuses from Ollama that mean "limit reached, try the next provider". */
    triggerStatuses: number[];
    /** Also fail over when Ollama Cloud is unreachable. */
    onNetworkError: boolean;
    /** After a limit hit, skip Ollama for this long (or until usage shows it reset). */
    cooldownSec: number;
    chain: FallbackProvider[];
  };
  downgrade: {
    enabled: boolean;
    /** Percent (0-100) of the tightest usage window at which to downgrade. */
    thresholdPercent: number;
    /** Glob map from model to its cheaper sibling, e.g. {"glm-5.3": "glm-5.3-flash"}. */
    map: Record<string, string>;
  };
  alerts: {
    /** Percentages at which to alert. */
    thresholds: number[];
    onReset: boolean;
    onFallback: boolean;
    desktop: boolean;
    telegram: { enabled: boolean; chatId: string };
    discord: { enabled: boolean };
  };
  /** Optional price table: key is "modelGlob" or "provider::modelGlob". */
  pricing: Record<string, Pricing>;
  logging: {
    retentionDays: number;
  };
  /** Where secrets live: a 0600 JSON file, or the OS keychain via optional `keytar`. */
  secretStore: 'file' | 'keychain';
}

export interface Secrets {
  ollamaApiKey?: string;
  proxyToken?: string;
  telegramBotToken?: string;
  discordWebhookUrl?: string;
  /** Keys for fallback providers, by provider name. */
  providers?: Record<string, string>;
}

export const DEFAULT_PORT = 4141;

export function defaultConfig(): GuardConfig {
  return {
    version: 1,
    server: { host: '127.0.0.1', port: DEFAULT_PORT, requireToken: false, localCountTokens: true },
    ollama: {
      baseUrl: 'https://ollama.com',
      accountLabel: 'personal',
      usageScope: 'self',
      pollIntervalSec: 60,
      requestTimeoutSec: 600,
    },
    models: { map: {} },
    fallback: {
      enabled: false,
      triggerStatuses: [429, 402],
      onNetworkError: false,
      cooldownSec: 300,
      chain: [],
    },
    downgrade: { enabled: false, thresholdPercent: 90, map: {} },
    alerts: {
      thresholds: [70, 90, 100],
      onReset: true,
      onFallback: true,
      desktop: true,
      telegram: { enabled: false, chatId: '' },
      discord: { enabled: false },
    },
    pricing: {},
    logging: { retentionDays: 30 },
    secretStore: 'file',
  };
}

export const PROVIDER_DEFAULTS: Record<ProviderType, { baseUrl: string; authStyle: AuthStyle }> = {
  'ollama-local': { baseUrl: 'http://localhost:11434', authStyle: 'none' },
  anthropic: { baseUrl: 'https://api.anthropic.com', authStyle: 'x-api-key' },
  openrouter: { baseUrl: 'https://openrouter.ai/api', authStyle: 'bearer' },
  'anthropic-compatible': { baseUrl: '', authStyle: 'bearer' },
};

type Plain = Record<string, unknown>;

function isPlain(v: unknown): v is Plain {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** Deep-merge user config over defaults. Arrays and maps are replaced, not merged. */
export function mergeConfig(base: GuardConfig, override: unknown): GuardConfig {
  const replaceWhole = new Set(['map', 'modelMap', 'pricing', 'chain', 'thresholds', 'triggerStatuses']);
  const merge = (a: Plain, b: Plain): Plain => {
    const out: Plain = { ...a };
    for (const [k, v] of Object.entries(b)) {
      if (v === undefined) continue;
      if (!replaceWhole.has(k) && isPlain(v) && isPlain(a[k])) out[k] = merge(a[k] as Plain, v);
      else out[k] = v;
    }
    return out;
  };
  if (!isPlain(override)) return structuredClone(base);
  return merge(structuredClone(base) as unknown as Plain, override) as unknown as GuardConfig;
}

export class ConfigError extends Error {
  constructor(public readonly problems: string[]) {
    super(`Invalid configuration:\n  - ${problems.join('\n  - ')}`);
    this.name = 'ConfigError';
  }
}

const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const isStrMap = (v: unknown): v is Record<string, string> => isPlain(v) && Object.values(v).every((x) => typeof x === 'string');

/** Validate a merged config. Returns the list of problems (empty when valid). */
export function validateConfig(c: GuardConfig): string[] {
  const p: string[] = [];
  if (c.version !== 1) p.push('version must be 1');
  if (!isNum(c.server.port) || c.server.port < 1 || c.server.port > 65535) p.push('server.port must be 1-65535');
  if (typeof c.server.host !== 'string' || !c.server.host) p.push('server.host must be a non-empty string');
  try {
    new URL(c.ollama.baseUrl);
  } catch {
    p.push('ollama.baseUrl must be a valid URL');
  }
  if (!['self', 'team'].includes(c.ollama.usageScope)) p.push('ollama.usageScope must be "self" or "team"');
  if (!isNum(c.ollama.pollIntervalSec) || c.ollama.pollIntervalSec < 15)
    p.push('ollama.pollIntervalSec must be >= 15 (the usage API allows 10 requests/minute)');
  if (!isNum(c.ollama.requestTimeoutSec) || c.ollama.requestTimeoutSec < 5) p.push('ollama.requestTimeoutSec must be >= 5');
  if (!isStrMap(c.models.map)) p.push('models.map must map strings to strings');
  if (!Array.isArray(c.fallback.triggerStatuses) || !c.fallback.triggerStatuses.every((s) => isNum(s) && s >= 400 && s < 600))
    p.push('fallback.triggerStatuses must be a list of HTTP error codes');
  if (!isNum(c.fallback.cooldownSec) || c.fallback.cooldownSec < 0) p.push('fallback.cooldownSec must be >= 0');
  if (!Array.isArray(c.fallback.chain)) p.push('fallback.chain must be a list');
  else {
    const names = new Set<string>();
    c.fallback.chain.forEach((fp, i) => {
      const where = `fallback.chain[${i}]`;
      if (!fp || typeof fp.name !== 'string' || !fp.name) p.push(`${where}.name is required`);
      else if (names.has(fp.name)) p.push(`${where}.name "${fp.name}" is duplicated`);
      else names.add(fp.name);
      if (!fp || !(fp.type in PROVIDER_DEFAULTS)) p.push(`${where}.type must be one of ${Object.keys(PROVIDER_DEFAULTS).join(', ')}`);
      if (fp?.type === 'anthropic-compatible' && !fp.baseUrl) p.push(`${where}.baseUrl is required for anthropic-compatible`);
      if (fp?.baseUrl) {
        try {
          new URL(fp.baseUrl);
        } catch {
          p.push(`${where}.baseUrl must be a valid URL`);
        }
      }
      if (fp?.modelMap !== undefined && !isStrMap(fp.modelMap)) p.push(`${where}.modelMap must map strings to strings`);
      // The hard rule: fallback must never be another Ollama Cloud account.
      if (fp?.baseUrl && /(^|\.)ollama\.com$/i.test(safeHost(fp.baseUrl)))
        p.push(
          `${where} points at ollama.com. Ollama Guard supports one Ollama Cloud account only; use local Ollama, Ollama extra usage, or another provider as fallback.`,
        );
    });
  }
  if (!isNum(c.downgrade.thresholdPercent) || c.downgrade.thresholdPercent < 1 || c.downgrade.thresholdPercent > 100)
    p.push('downgrade.thresholdPercent must be 1-100');
  if (!isStrMap(c.downgrade.map)) p.push('downgrade.map must map strings to strings');
  if (!Array.isArray(c.alerts.thresholds) || !c.alerts.thresholds.every((t) => isNum(t) && t > 0 && t <= 100))
    p.push('alerts.thresholds must be percentages between 1 and 100');
  if (!isPlain(c.pricing)) p.push('pricing must be an object');
  if (!isNum(c.logging.retentionDays) || c.logging.retentionDays < 1) p.push('logging.retentionDays must be >= 1');
  if (!['file', 'keychain'].includes(c.secretStore)) p.push('secretStore must be "file" or "keychain"');
  return p;
}

function safeHost(u: string): string {
  try {
    return new URL(u).hostname;
  } catch {
    return '';
  }
}

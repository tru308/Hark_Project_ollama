import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { paths } from './paths.js';
import { ConfigError, defaultConfig, mergeConfig, validateConfig, type GuardConfig, type Secrets } from './schema.js';

const KEYCHAIN_SERVICE = 'ollama-guard';
const KEYCHAIN_ACCOUNT = 'secrets';

export function ensureHome(): void {
  fs.mkdirSync(paths.home, { recursive: true, mode: 0o700 });
  fs.mkdirSync(paths.logsDir, { recursive: true, mode: 0o700 });
}

/** Write a file atomically with owner-only permissions (best effort on Windows). */
export function writePrivateFile(file: string, content: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, content, { mode: 0o600 });
  fs.renameSync(tmp, file);
  try {
    fs.chmodSync(file, 0o600);
  } catch {
    /* Windows: NTFS ACLs on the user profile already restrict access. */
  }
}

export function configExists(): boolean {
  return fs.existsSync(paths.config);
}

export function readRawConfig(): unknown {
  if (!configExists()) return {};
  const text = fs.readFileSync(paths.config, 'utf8');
  try {
    return JSON.parse(text) as unknown;
  } catch (err) {
    throw new ConfigError([`${paths.config} is not valid JSON: ${(err as Error).message}`]);
  }
}

export function loadConfig(): GuardConfig {
  const cfg = mergeConfig(defaultConfig(), readRawConfig());
  const problems = validateConfig(cfg);
  if (problems.length) throw new ConfigError(problems);
  return cfg;
}

export function saveConfig(cfg: GuardConfig): void {
  const problems = validateConfig(cfg);
  if (problems.length) throw new ConfigError(problems);
  ensureHome();
  writePrivateFile(paths.config, `${JSON.stringify(cfg, null, 2)}\n`);
}

// ---------------------------------------------------------------- secrets

interface KeytarLike {
  getPassword(service: string, account: string): Promise<string | null>;
  setPassword(service: string, account: string, password: string): Promise<void>;
}

let keytarCache: KeytarLike | null | undefined;

/** keytar is optional: `npm i -g keytar` next to ollama-guard to enable OS keychain storage. */
export async function loadKeytar(): Promise<KeytarLike | null> {
  if (keytarCache !== undefined) return keytarCache;
  try {
    const name = 'keytar';
    const mod = (await import(name)) as { default?: KeytarLike } & KeytarLike;
    keytarCache = mod.default ?? mod;
  } catch {
    keytarCache = null;
  }
  return keytarCache;
}

function readSecretsFile(): Secrets {
  if (!fs.existsSync(paths.secrets)) return {};
  try {
    return JSON.parse(fs.readFileSync(paths.secrets, 'utf8')) as Secrets;
  } catch {
    return {};
  }
}

export async function loadSecrets(cfg: Pick<GuardConfig, 'secretStore'>): Promise<Secrets> {
  let secrets: Secrets = {};
  if (cfg.secretStore === 'keychain') {
    const keytar = await loadKeytar();
    if (keytar) {
      const blob = await keytar.getPassword(KEYCHAIN_SERVICE, KEYCHAIN_ACCOUNT);
      if (blob) secrets = JSON.parse(blob) as Secrets;
    } else {
      secrets = readSecretsFile();
    }
  } else {
    secrets = readSecretsFile();
  }
  // Environment always wins, so CI and one-off runs need no files.
  if (process.env.OLLAMA_API_KEY) secrets = { ...secrets, ollamaApiKey: process.env.OLLAMA_API_KEY };
  return secrets;
}

export async function saveSecrets(cfg: Pick<GuardConfig, 'secretStore'>, secrets: Secrets): Promise<'file' | 'keychain'> {
  ensureHome();
  if (cfg.secretStore === 'keychain') {
    const keytar = await loadKeytar();
    if (keytar) {
      await keytar.setPassword(KEYCHAIN_SERVICE, KEYCHAIN_ACCOUNT, JSON.stringify(secrets));
      if (fs.existsSync(paths.secrets)) fs.rmSync(paths.secrets);
      return 'keychain';
    }
  }
  writePrivateFile(paths.secrets, `${JSON.stringify(secrets, null, 2)}\n`);
  return 'file';
}

export function newProxyToken(): string {
  return `og_${crypto.randomBytes(24).toString('base64url')}`;
}

/** Resolve a fallback provider's key: env var first, then the secret store. */
export function providerKey(secrets: Secrets, name: string, apiKeyEnv?: string): string | undefined {
  if (apiKeyEnv && process.env[apiKeyEnv]) return process.env[apiKeyEnv];
  return secrets.providers?.[name];
}

export function maskSecret(s: string | undefined): string {
  if (!s) return '(not set)';
  if (s.length <= 8) return '••••';
  return `${s.slice(0, 4)}••••${s.slice(-4)}`;
}

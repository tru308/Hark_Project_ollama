import os from 'node:os';
import path from 'node:path';

/**
 * Every file Ollama Guard writes lives under one directory:
 * ~/.ollama-guard (override with OLLAMA_GUARD_HOME, mainly for tests).
 */
export function guardHome(): string {
  const override = process.env.OLLAMA_GUARD_HOME;
  if (override && override.trim()) return path.resolve(override.trim());
  return path.join(os.homedir(), '.ollama-guard');
}

export const paths = {
  get home() {
    return guardHome();
  },
  get config() {
    return path.join(guardHome(), 'config.json');
  },
  get secrets() {
    return path.join(guardHome(), 'secrets.json');
  },
  get state() {
    return path.join(guardHome(), 'state.json');
  },
  get pid() {
    return path.join(guardHome(), 'guard.pid');
  },
  get logsDir() {
    return path.join(guardHome(), 'logs');
  },
  get daemonLog() {
    return path.join(guardHome(), 'guard.log');
  },
};

/** Claude Code's user settings file (statusLine and env live here). */
export function claudeSettingsPath(): string {
  const override = process.env.CLAUDE_CONFIG_DIR;
  const base = override && override.trim() ? override.trim() : path.join(os.homedir(), '.claude');
  return path.join(base, 'settings.json');
}

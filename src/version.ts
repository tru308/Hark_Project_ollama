import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

function readVersion(): string {
  for (const p of ['../package.json', '../../package.json']) {
    try {
      const pkg = require(p) as { name?: string; version?: string };
      if (pkg.name === 'ollama-guard' && pkg.version) return pkg.version;
    } catch {
      /* try next */
    }
  }
  return '0.0.0';
}

export const VERSION = readVersion();

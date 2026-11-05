// Copies non-TypeScript assets (the dashboard) into dist/ and marks the CLI executable.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const src = path.join(root, 'src', 'dashboard');
const dest = path.join(root, 'dist', 'dashboard');
fs.mkdirSync(dest, { recursive: true });
for (const f of fs.readdirSync(src)) fs.copyFileSync(path.join(src, f), path.join(dest, f));

const cli = path.join(root, 'dist', 'cli.js');
if (fs.existsSync(cli)) {
  try {
    fs.chmodSync(cli, 0o755);
  } catch {
    /* Windows */
  }
}
console.log('assets copied → dist/dashboard');

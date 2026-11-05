import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Never touch the real ~/.ollama-guard or ~/.claude while testing.
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ollama-guard-test-'));
process.env.OLLAMA_GUARD_HOME = home;
process.env.CLAUDE_CONFIG_DIR = path.join(home, 'claude');
process.env.NO_COLOR = '1';
delete process.env.OLLAMA_API_KEY;

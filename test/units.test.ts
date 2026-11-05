import fs from 'node:fs';
import { describe, expect, it } from 'vitest';
import { mapModel, matchModel } from '../src/proxy/modelMap.js';
import { SseUsageTap } from '../src/proxy/sse.js';
import { detectProject } from '../src/proxy/project.js';
import { formatStatusline } from '../src/statusline.js';
import { claudeEnvVars, renderEnv } from '../src/commands/env.js';
import { defaultConfig, mergeConfig, validateConfig } from '../src/config/schema.js';
import { formatDuration } from '../src/util/format.js';
import { parseArgs } from '../src/util/args.js';
import { sseMessage } from './helpers.js';
import type { GuardStatus } from '../src/runtime.js';

describe('model mapping', () => {
  const map = { 'claude-*': 'glm-5.3', 'claude-*haiku*': 'glm-5.3-flash', 'gpt-oss:120b': 'gpt-oss:20b' };
  it('prefers exact, then most specific glob', () => {
    expect(matchModel('gpt-oss:120b', map)).toBe('gpt-oss:20b');
    expect(mapModel('claude-haiku-4-5-20251001', map)).toBe('glm-5.3-flash');
    expect(mapModel('claude-sonnet-4-5', map)).toBe('glm-5.3');
  });
  it('keeps the model when nothing matches, or uses the default', () => {
    expect(mapModel('kimi-k3', map)).toBe('kimi-k3');
    expect(mapModel('kimi-k3', map, 'qwen3-coder')).toBe('qwen3-coder');
  });
  it('treats regex characters literally', () => {
    expect(matchModel('a.b', { 'a.b': 'x' })).toBe('x');
    expect(matchModel('axb', { 'a.b*': 'x' })).toBeUndefined();
  });
});

describe('SSE usage tap', () => {
  it('extracts usage across arbitrary chunk boundaries', () => {
    const text = sseMessage('glm-5.3', 'hello', 100, 25);
    const tap = new SseUsageTap();
    const bytes = new TextEncoder().encode(text);
    for (let i = 0; i < bytes.length; i += 7) tap.push(bytes.slice(i, i + 7));
    tap.end();
    expect(tap).toMatchObject({ inputTokens: 100, outputTokens: 25, model: 'glm-5.3', stopReason: 'end_turn' });
  });
  it('counts cached input tokens', () => {
    const tap = new SseUsageTap();
    tap.push(
      `data: ${JSON.stringify({ type: 'message_start', message: { usage: { input_tokens: 10, cache_read_input_tokens: 90 } } })}\n\n`,
    );
    expect(tap.inputTokens).toBe(100);
  });
  it('handles CRLF line endings', () => {
    const tap = new SseUsageTap();
    tap.push(`event: message_delta\r\ndata: {"type":"message_delta","usage":{"output_tokens":9}}\r\n\r\n`);
    expect(tap.outputTokens).toBe(9);
  });
});

describe('project detection', () => {
  it('uses the explicit header first', () => {
    expect(detectProject({ 'x-ollama-guard-project': 'bake-and-bites' }, {})).toBe('bake-and-bites');
  });
  it('reads POSIX and Windows working directories', () => {
    expect(detectProject({}, { system: 'Working directory: /home/t/code/corpverse/' })).toBe('corpverse');
    expect(detectProject({}, { system: [{ type: 'text', text: 'Primary working directory: D:\\work\\ollama-guard' }] })).toBe(
      'ollama-guard',
    );
  });
  it('falls back to unknown', () => {
    expect(detectProject({}, { system: 'nothing here' })).toBe('unknown');
  });
});

const baseStatus = (): GuardStatus => ({
  version: '0.1.0',
  startedAt: '',
  account: { label: 'personal', scope: 'self', keyConfigured: true },
  usage: {
    fetchedAt: '',
    ok: true,
    windows: [
      { id: 'session', label: 'Session', used: 0.63, resetsAt: new Date(Date.now() + (2 * 60 + 10) * 60_000 + 20_000).toISOString() },
    ],
    headline: {
      id: 'session',
      label: 'Session',
      used: 0.63,
      resetsAt: new Date(Date.now() + (2 * 60 + 10) * 60_000 + 20_000).toISOString(),
    },
  },
  fallback: { enabled: false, chain: [], active: false },
  downgrade: { enabled: false, active: false, thresholdPercent: 90 },
  alerts: [],
  server: { host: '127.0.0.1', port: 4141, requireToken: false },
});

describe('status line', () => {
  it('renders the classic line', () => {
    expect(formatStatusline(baseStatus(), { color: false })).toBe('Ollama 63% · resets 2h 10m · fallback: off');
  });
  it('shows an active fallback', () => {
    const s = baseStatus();
    s.fallback = { enabled: true, chain: [{ name: 'local', type: 'ollama-local' }], active: true, provider: 'local', model: 'qwen3-coder' };
    expect(formatStatusline(s, { color: false })).toContain('fallback: local (qwen3-coder)');
  });
  it('says when the guard is offline', () => {
    expect(formatStatusline(undefined, { color: false })).toContain('offline');
  });
  it('colours high usage red', () => {
    const s = baseStatus();
    s.usage!.headline!.used = 0.95;
    expect(formatStatusline(s, { color: true })).toContain('\x1b[31m95%');
  });
});

describe('env output', () => {
  const vars = claudeEnvVars(defaultConfig(), {});
  it('targets the local proxy with an empty API key', () => {
    expect(vars).toEqual({ ANTHROPIC_BASE_URL: 'http://127.0.0.1:4141', ANTHROPIC_AUTH_TOKEN: 'ollama-guard', ANTHROPIC_API_KEY: '' });
  });
  it('renders every shell', () => {
    expect(renderEnv(vars, 'bash')).toContain('export ANTHROPIC_BASE_URL="http://127.0.0.1:4141"');
    expect(renderEnv(vars, 'powershell')).toContain('$env:ANTHROPIC_BASE_URL = "http://127.0.0.1:4141"');
    expect(renderEnv(vars, 'cmd')).toContain('set "ANTHROPIC_API_KEY="');
    expect(renderEnv(vars, 'fish')).toContain('set -gx ANTHROPIC_AUTH_TOKEN "ollama-guard"');
  });
  it('uses the proxy token when required', () => {
    const cfg = mergeConfig(defaultConfig(), { server: { requireToken: true } });
    expect(claudeEnvVars(cfg, { proxyToken: 'og_x' }).ANTHROPIC_AUTH_TOKEN).toBe('og_x');
  });
});

describe('config validation', () => {
  it('accepts the defaults', () => {
    expect(validateConfig(defaultConfig())).toEqual([]);
  });
  it('rejects polling faster than the usage API allows', () => {
    expect(validateConfig(mergeConfig(defaultConfig(), { ollama: { pollIntervalSec: 5 } })).join()).toMatch(/pollIntervalSec/);
  });
  it('rejects ollama.com as a fallback (one account only)', () => {
    const cfg = mergeConfig(defaultConfig(), {
      fallback: { chain: [{ name: 'x', type: 'anthropic-compatible', baseUrl: 'https://api.ollama.com' }] },
    });
    expect(validateConfig(cfg).join()).toMatch(/one Ollama Cloud account/);
  });
  it('ships a valid example config', () => {
    const example = JSON.parse(fs.readFileSync(new URL('../examples/config.example.json', import.meta.url), 'utf8'));
    expect(validateConfig(mergeConfig(defaultConfig(), example))).toEqual([]);
  });
  it('replaces arrays instead of merging them', () => {
    expect(mergeConfig(defaultConfig(), { alerts: { thresholds: [80] } }).alerts.thresholds).toEqual([80]);
  });
});

describe('helpers', () => {
  it('formats durations', () => {
    expect(formatDuration(130 * 60_000)).toBe('2h 10m');
    expect(formatDuration(26 * 3600_000)).toBe('1d 2h');
    expect(formatDuration(-5)).toBe('now');
  });
  it('parses CLI args', () => {
    expect(parseArgs(['start', '--port', '5000', '--open', '--no-color'])).toEqual({
      cmd: 'start',
      positional: [],
      flags: { port: '5000', open: true, color: false },
    });
    expect(parseArgs(['logs', '-n', '5', '-f']).flags).toEqual({ n: '5', follow: true });
    expect(parseArgs(['env', '--shell=powershell']).flags.shell).toBe('powershell');
  });
});

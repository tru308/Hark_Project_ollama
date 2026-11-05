import { describe, expect, it, vi } from 'vitest';
import { AlertEngine } from '../src/alerts/engine.js';
import { escapeMd, sendDiscord, sendTelegram } from '../src/alerts/channels.js';
import type { UsageSnapshot } from '../src/usage/normalize.js';

const RESET = '2026-11-05T18:00:00Z';
const snap = (used: number, resetsAt = RESET, id: 'session' | 'weekly' = 'session'): UsageSnapshot => ({
  fetchedAt: new Date().toISOString(),
  ok: true,
  windows: [{ id, label: id === 'session' ? 'Session' : 'Weekly', used, resetsAt }],
});
const now = new Date('2026-11-05T15:50:00Z');

describe('AlertEngine thresholds', () => {
  it('fires once when crossing 70%', () => {
    const e = new AlertEngine({ thresholds: [70, 90, 100], onReset: true });
    expect(e.evaluate(snap(0.5), undefined, now)).toHaveLength(0);
    const a = e.evaluate(snap(0.72), snap(0.5), now);
    expect(a).toHaveLength(1);
    expect(a[0]).toMatchObject({ kind: 'threshold', threshold: 70, level: 'info' });
    expect(a[0]!.message).toContain('Resets in 2h 10m');
    expect(e.evaluate(snap(0.75), snap(0.72), now)).toHaveLength(0);
  });

  it('reports only the highest threshold when jumping past several', () => {
    const e = new AlertEngine({ thresholds: [70, 90, 100], onReset: true });
    const a = e.evaluate(snap(0.95), undefined, now);
    expect(a).toHaveLength(1);
    expect(a[0]).toMatchObject({ threshold: 90, level: 'warning' });
    // 70 was implicitly consumed too.
    expect(e.evaluate(snap(0.96), snap(0.95), now)).toHaveLength(0);
  });

  it('marks 100% as critical', () => {
    const e = new AlertEngine({ thresholds: [70, 90, 100], onReset: true });
    e.evaluate(snap(0.91), undefined, now);
    const a = e.evaluate(snap(1), snap(0.91), now);
    expect(a[0]).toMatchObject({ threshold: 100, level: 'critical', title: 'Session limit reached' });
  });

  it('respects custom thresholds', () => {
    const e = new AlertEngine({ thresholds: [50], onReset: false });
    expect(e.evaluate(snap(0.55), undefined, now)[0]!.threshold).toBe(50);
  });

  it('tracks windows independently', () => {
    const e = new AlertEngine({ thresholds: [70], onReset: true });
    const both: UsageSnapshot = { ...snap(0.8), windows: [snap(0.8).windows[0]!, snap(0.75, RESET, 'weekly').windows[0]!] };
    expect(e.evaluate(both, undefined, now).map((a) => a.windowId)).toEqual(['session', 'weekly']);
  });

  it('survives restarts without re-alerting (persisted keys)', () => {
    const e1 = new AlertEngine({ thresholds: [70, 90], onReset: true });
    e1.evaluate(snap(0.92), undefined, now);
    const e2 = new AlertEngine({ thresholds: [70, 90], onReset: true }, e1.firedKeys());
    expect(e2.evaluate(snap(0.93), undefined, now)).toHaveLength(0);
  });

  it('does not re-alert when resets_at drifts slightly between polls', () => {
    const e = new AlertEngine({ thresholds: [100], onReset: true });
    expect(e.evaluate(snap(1, '2026-11-05T18:00:00Z'), undefined, now)).toHaveLength(1);
    expect(e.evaluate(snap(1, '2026-11-05T18:00:11Z'), snap(1, '2026-11-05T18:00:00Z'), now)).toHaveLength(0);
  });

  it('ignores snapshots that failed with no data', () => {
    const e = new AlertEngine({ thresholds: [70], onReset: true });
    expect(e.evaluate({ fetchedAt: '', ok: false, error: 'x', windows: [] }, undefined, now)).toHaveLength(0);
  });
});

describe('AlertEngine resets', () => {
  it('announces a reset when the window rolls over, and re-arms thresholds', () => {
    const e = new AlertEngine({ thresholds: [70, 90, 100], onReset: true });
    e.evaluate(snap(1), undefined, now);
    const next = snap(0.03, '2026-11-05T23:00:00Z');
    const a = e.evaluate(next, snap(1), now);
    expect(a.map((x) => x.kind)).toEqual(['reset']);
    expect(a[0]!.title).toBe('Session limit reset');
    // Thresholds fire again in the new period.
    expect(e.evaluate(snap(0.71, '2026-11-05T23:00:00Z'), next, now)[0]!.threshold).toBe(70);
  });

  it('detects a reset from a sharp drop even without reset times', () => {
    const e = new AlertEngine({ thresholds: [70], onReset: true });
    const a = e.evaluate(snap(0.1, ''), snap(0.95, ''), now);
    expect(a.some((x) => x.kind === 'reset')).toBe(true);
  });

  it('stays quiet about resets from low usage', () => {
    const e = new AlertEngine({ thresholds: [70], onReset: true });
    expect(e.evaluate(snap(0.01, '2026-11-06T00:00:00Z'), snap(0.4), now)).toHaveLength(0);
  });

  it('can disable reset alerts', () => {
    const e = new AlertEngine({ thresholds: [70], onReset: false });
    expect(e.evaluate(snap(0.05, '2026-11-06T00:00:00Z'), snap(0.95), now)).toHaveLength(0);
  });
});

describe('alert channels', () => {
  const alert = {
    kind: 'threshold' as const,
    level: 'warning' as const,
    title: 'Session usage at 90%',
    message: 'Resets in 1h.',
    at: now.toISOString(),
  };

  it('posts MarkdownV2-escaped text to Telegram', async () => {
    const f = vi.fn(async () => new Response('{"ok":true}', { status: 200 }));
    const r = await sendTelegram(alert, 'TOKEN', '12345', f as unknown as typeof fetch);
    expect(r.ok).toBe(true);
    const [url, init] = f.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://api.telegram.org/botTOKEN/sendMessage');
    const body = JSON.parse(init.body as string);
    expect(body.chat_id).toBe('12345');
    expect(body.text).toContain('Resets in 1h\\.');
  });

  it('posts an embed to Discord', async () => {
    const f = vi.fn(async () => new Response(null, { status: 204 }));
    const r = await sendDiscord(alert, 'https://discord.com/api/webhooks/x', f as unknown as typeof fetch);
    expect(r.ok).toBe(true);
    const body = JSON.parse((f.mock.calls[0] as unknown as [string, RequestInit])[1].body as string);
    expect(body.embeds[0].title).toBe('Session usage at 90%');
  });

  it('reports channel failures instead of throwing', async () => {
    const f = vi.fn(async () => new Response('bad', { status: 401 }));
    const r = await sendTelegram(alert, 'bad', '1', f as unknown as typeof fetch);
    expect(r).toMatchObject({ ok: false, channel: 'telegram' });
  });

  it('escapes Telegram special characters', () => {
    expect(escapeMd('90% (session).')).toBe('90% \\(session\\)\\.');
  });
});

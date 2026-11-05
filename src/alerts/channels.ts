import { createRequire } from 'node:module';
import type { GuardConfig, Secrets } from '../config/schema.js';
import type { Alert } from './engine.js';

export interface ChannelResult {
  channel: 'desktop' | 'telegram' | 'discord';
  ok: boolean;
  error?: string;
}

const EMOJI: Record<Alert['level'], string> = { info: '🟢', warning: '🟠', critical: '🔴' };

export async function sendDesktop(alert: Alert): Promise<ChannelResult> {
  try {
    const require = createRequire(import.meta.url);
    const notifier = require('node-notifier') as {
      notify(opts: Record<string, unknown>, cb?: (err: Error | null) => void): void;
    };
    await new Promise<void>((resolve, reject) => {
      notifier.notify(
        {
          title: `Ollama Guard · ${alert.title}`,
          message: alert.message,
          sound: alert.level !== 'info',
          appID: 'Ollama Guard',
          wait: false,
        },
        (err) => (err ? reject(err) : resolve()),
      );
    });
    return { channel: 'desktop', ok: true };
  } catch (err) {
    return { channel: 'desktop', ok: false, error: (err as Error).message };
  }
}

export async function sendTelegram(
  alert: Alert,
  botToken: string,
  chatId: string,
  fetchImpl: typeof fetch = fetch,
): Promise<ChannelResult> {
  try {
    const res = await fetchImpl(`https://api.telegram.org/bot${botToken}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: chatId,
        text: `${EMOJI[alert.level]} *${escapeMd(alert.title)}*\n${escapeMd(alert.message)}`,
        parse_mode: 'MarkdownV2',
        disable_web_page_preview: true,
      }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) return { channel: 'telegram', ok: false, error: `${res.status} ${(await res.text()).slice(0, 200)}` };
    return { channel: 'telegram', ok: true };
  } catch (err) {
    return { channel: 'telegram', ok: false, error: (err as Error).message };
  }
}

export async function sendDiscord(alert: Alert, webhookUrl: string, fetchImpl: typeof fetch = fetch): Promise<ChannelResult> {
  try {
    const color = alert.level === 'critical' ? 0xff3b30 : alert.level === 'warning' ? 0xff9f0a : 0x34c759;
    const res = await fetchImpl(webhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        username: 'Ollama Guard',
        embeds: [{ title: alert.title, description: alert.message, color, timestamp: alert.at }],
      }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) return { channel: 'discord', ok: false, error: `${res.status} ${(await res.text()).slice(0, 200)}` };
    return { channel: 'discord', ok: true };
  } catch (err) {
    return { channel: 'discord', ok: false, error: (err as Error).message };
  }
}

/** Telegram MarkdownV2 requires escaping these characters. */
export function escapeMd(s: string): string {
  return s.replace(/[_*[\]()~`>#+\-=|{}.!\\]/g, (m) => `\\${m}`);
}

/** Deliver one alert to every configured channel; never throws. */
export async function dispatchAlert(alert: Alert, cfg: GuardConfig, secrets: Secrets): Promise<ChannelResult[]> {
  const jobs: Promise<ChannelResult>[] = [];
  if (cfg.alerts.desktop) jobs.push(sendDesktop(alert));
  if (cfg.alerts.telegram.enabled) {
    if (secrets.telegramBotToken && cfg.alerts.telegram.chatId)
      jobs.push(sendTelegram(alert, secrets.telegramBotToken, cfg.alerts.telegram.chatId));
    else jobs.push(Promise.resolve({ channel: 'telegram', ok: false, error: 'bot token or chat id missing' }));
  }
  if (cfg.alerts.discord.enabled) {
    if (secrets.discordWebhookUrl) jobs.push(sendDiscord(alert, secrets.discordWebhookUrl));
    else jobs.push(Promise.resolve({ channel: 'discord', ok: false, error: 'webhook URL missing' }));
  }
  return Promise.all(jobs);
}

/** Find the chat id of whoever last messaged the bot (used by `init`). */
export async function discoverTelegramChatId(botToken: string, fetchImpl: typeof fetch = fetch): Promise<string | undefined> {
  const res = await fetchImpl(`https://api.telegram.org/bot${botToken}/getUpdates`, { signal: AbortSignal.timeout(10_000) });
  if (!res.ok) throw new Error(`Telegram said ${res.status}. Is the bot token right?`);
  const j = (await res.json()) as { result?: Array<{ message?: { chat?: { id?: number } } }> };
  const ids = (j.result ?? []).map((u) => u.message?.chat?.id).filter((x): x is number => typeof x === 'number');
  const last = ids[ids.length - 1];
  return last === undefined ? undefined : String(last);
}

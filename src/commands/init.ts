import { paths } from '../config/paths.js';
import { defaultConfig, type FallbackProvider, type GuardConfig, type Secrets } from '../config/schema.js';
import { configExists, ensureHome, loadConfig, loadKeytar, loadSecrets, newProxyToken, saveConfig, saveSecrets } from '../config/store.js';
import { discoverTelegramChatId, sendTelegram } from '../alerts/channels.js';
import { OllamaApiError, OllamaUsageClient } from '../usage/client.js';
import { normalizeUsage } from '../usage/normalize.js';
import { Prompter } from '../util/prompt.js';
import { banner, c, sym } from '../util/term.js';
import { claudeEnvVars, detectShell, renderEnv } from './env.js';
import { installStatusline } from './status.js';

const DEFAULT_MODEL = 'glm-5.3';
const DEFAULT_CHEAP_MODEL = 'glm-5.3-flash';

async function cloudModels(baseUrl: string): Promise<string[]> {
  try {
    const res = await fetch(new URL('/api/tags', baseUrl), { signal: AbortSignal.timeout(6000) });
    const j = (await res.json()) as { models?: Array<{ name: string; capabilities?: string[] }> };
    return (j.models ?? []).filter((m) => !m.capabilities || m.capabilities.includes('tools')).map((m) => m.name);
  } catch {
    return [];
  }
}

async function localModels(baseUrl = 'http://localhost:11434'): Promise<string[] | undefined> {
  try {
    const res = await fetch(`${baseUrl}/api/tags`, { signal: AbortSignal.timeout(2500) });
    const j = (await res.json()) as { models?: Array<{ name: string }> };
    return (j.models ?? []).map((m) => m.name).filter((n) => !n.endsWith(':cloud') && !n.includes('-cloud'));
  } catch {
    return undefined;
  }
}

export async function runInit(opts: { nonInteractive?: boolean }): Promise<void> {
  ensureHome();
  const existing: GuardConfig = configExists() ? safeLoad() : defaultConfig();
  const secrets: Secrets = await loadSecrets(existing);

  if (opts.nonInteractive) {
    if (!secrets.ollamaApiKey) throw new Error('Set OLLAMA_API_KEY to run `init --yes` non-interactively.');
    if (!Object.keys(existing.models.map).length) existing.models.map = { 'claude-*': DEFAULT_MODEL };
    secrets.proxyToken ??= newProxyToken();
    saveConfig(existing);
    // Do not copy an env-provided key into the store unless it was already there.
    const stored = await loadSecretsRaw(existing);
    await saveSecrets(existing, { ...stored, proxyToken: secrets.proxyToken });
    console.log(`${sym.ok()} Wrote ${paths.config}`);
    return;
  }

  const p = new Prompter();
  try {
    console.log(banner('setup'));
    console.log(`  ${c.gray('Takes about a minute. Press Enter to accept the value in (brackets).')}`);
    console.log(`  ${c.gray('Ollama Guard uses ONE Ollama account. It never rotates keys or accounts.')}\n`);

    const cfg = existing;

    // 1 — API key
    console.log(`  ${c.bold('1. Your Ollama API key')} ${c.gray('· create one at https://ollama.com/settings/keys')}`);
    let key = secrets.ollamaApiKey;
    if (key) {
      const keep = await p.confirm(`Keep the saved key (${key.slice(0, 4)}…${key.slice(-4)})?`, true);
      if (!keep) key = undefined;
    }
    while (!key) {
      key = await p.secret('Paste your API key:');
      if (!key) console.log(`    ${sym.warn()} A key is required.`);
    }
    process.stdout.write(`    ${c.gray('Checking the key with ollama.com…')} `);
    const client = new OllamaUsageClient({ baseUrl: cfg.ollama.baseUrl, apiKey: key, timeoutMs: 10_000 });
    try {
      const balance = await client.balance();
      const snap = normalizeUsage({ balance });
      const desc = snap.windows.map((w) => `${w.label.toLowerCase()} ${Math.round(w.used * 100)}%`).join(' · ');
      console.log(`${sym.ok()} ${desc ? c.gray(desc) : 'accepted'}`);
    } catch (err) {
      const e = err as OllamaApiError;
      if (e.status === 401) {
        console.log(`${sym.fail()} Ollama rejected this key.`);
        if (!(await p.confirm('Save it anyway?', false))) throw new Error('Setup cancelled: invalid API key.', { cause: err });
      } else console.log(`${sym.warn()} ${c.gray(`could not verify (${e.message}); continuing`)}`);
    }
    secrets.ollamaApiKey = key;

    // 2 — Account scope
    console.log(`\n  ${c.bold('2. Account')}`);
    const scope = await p.choose(
      'Which usage should the meter show?',
      [
        { value: 'self', label: 'My own usage', hint: 'personal account, or my share of a team' },
        { value: 'team', label: "My team's total usage", hint: 'team admins only; same single key' },
      ],
      cfg.ollama.usageScope === 'team' ? 1 : 0,
    );
    cfg.ollama.usageScope = scope;
    cfg.ollama.accountLabel =
      scope === 'team'
        ? await p.text('Team name (for display):', cfg.ollama.accountLabel === 'personal' ? 'team' : cfg.ollama.accountLabel)
        : 'personal';

    // 3 — Model
    console.log(`\n  ${c.bold('3. Model')}`);
    const models = await cloudModels(cfg.ollama.baseUrl);
    if (models.length)
      console.log(`    ${c.gray(`Cloud models with tool support: ${models.slice(0, 10).join(', ')}${models.length > 10 ? ', …' : ''}`)}`);
    const current = cfg.models.map['claude-*'] ?? DEFAULT_MODEL;
    const model = await p.text('Ollama model to use when Claude Code asks for a Claude model:', current);
    const fast = await p.text(
      'Model for quick background tasks (Claude "haiku" requests):',
      cfg.models.map['claude-*haiku*'] ?? (model === DEFAULT_MODEL ? DEFAULT_CHEAP_MODEL : model),
    );
    cfg.models.map = { ...cfg.models.map, 'claude-*': model, 'claude-*haiku*': fast };

    // 4 — Port
    console.log(`\n  ${c.bold('4. Local port')}`);
    cfg.server.port = Number(await p.text('Port for the proxy and dashboard:', String(cfg.server.port))) || cfg.server.port;
    cfg.server.requireToken = await p.confirm(
      'Require a private token from Claude Code? (extra safety on shared machines)',
      cfg.server.requireToken,
    );
    secrets.proxyToken ??= newProxyToken();

    // 5 — Fallback
    console.log(`\n  ${c.bold('5. Fallback when you hit a limit')} ${c.gray('· legitimate alternatives only')}`);
    const local = await localModels();
    const fbChoice = await p.choose(
      'Where should requests go when Ollama Cloud says you are out of quota?',
      [
        { value: 'none', label: 'Nowhere, just show the error', hint: 'simplest' },
        {
          value: 'local',
          label: 'Local Ollama models on this computer',
          hint: local ? `${local.length} models found` : 'Ollama app not detected',
        },
        { value: 'openrouter', label: 'OpenRouter', hint: 'your own OpenRouter key' },
        { value: 'anthropic', label: 'Anthropic API', hint: 'your own Anthropic key' },
      ],
      cfg.fallback.chain.length ? 0 : local?.length ? 1 : 0,
    );
    const chain: FallbackProvider[] = [];
    if (fbChoice === 'local') {
      if (local?.length) console.log(`    ${c.gray(`Local models: ${local.slice(0, 8).join(', ')}`)}`);
      const lm = await p.text('Local model to use:', local?.[0] ?? 'qwen3-coder');
      chain.push({ name: 'local', type: 'ollama-local', defaultModel: lm });
    } else if (fbChoice === 'openrouter') {
      const k = await p.secret('OpenRouter API key:');
      const m = await p.text('OpenRouter model id:', 'anthropic/claude-sonnet-4.5');
      chain.push({ name: 'openrouter', type: 'openrouter', defaultModel: m });
      secrets.providers = { ...(secrets.providers ?? {}), openrouter: k };
    } else if (fbChoice === 'anthropic') {
      const k = await p.secret('Anthropic API key:');
      chain.push({
        name: 'anthropic',
        type: 'anthropic',
        modelMap: { 'claude-*': 'claude-sonnet-4-5' },
        defaultModel: 'claude-sonnet-4-5',
      });
      secrets.providers = { ...(secrets.providers ?? {}), anthropic: k };
    }
    if (fbChoice !== 'none') {
      cfg.fallback.chain = chain;
      cfg.fallback.enabled = true;
    } else if (!cfg.fallback.chain.length) cfg.fallback.enabled = false;
    console.log(
      `    ${c.gray('Tip: with Ollama extra usage (pay-as-you-go) enabled on ollama.com, Ollama keeps serving you past the plan limit, and Guard tracks the purchased balance.')}`,
    );

    // 6 — Downgrade
    cfg.downgrade.enabled = await p.confirm(`Switch ${model} to a cheaper model when usage passes 90%?`, cfg.downgrade.enabled);
    if (cfg.downgrade.enabled) {
      const cheap = await p.text('Cheaper model:', fast !== model ? fast : DEFAULT_CHEAP_MODEL);
      cfg.downgrade.map = { [model]: cheap };
      cfg.downgrade.thresholdPercent = Number(await p.text('Downgrade at what percent?', String(cfg.downgrade.thresholdPercent))) || 90;
    }

    // 7 — Alerts
    console.log(`\n  ${c.bold('6. Alerts')} ${c.gray(`· at ${cfg.alerts.thresholds.join('/')}% and when limits reset`)}`);
    cfg.alerts.desktop = await p.confirm('Desktop notifications?', cfg.alerts.desktop);
    if (await p.confirm('Telegram alerts on your phone?', cfg.alerts.telegram.enabled)) {
      console.log(`    ${c.gray('1) In Telegram, open @BotFather and send /newbot. 2) Copy the token it gives you.')}`);
      const tok = (await p.secret('Bot token:')) || secrets.telegramBotToken || '';
      console.log(`    ${c.gray('3) Open your new bot in Telegram and send it any message (e.g. "hi"), then press Enter here.')}`);
      await p.text('Sent it?', 'yes');
      let chatId = cfg.alerts.telegram.chatId;
      try {
        chatId = (await discoverTelegramChatId(tok)) ?? chatId;
      } catch (err) {
        console.log(`    ${sym.warn()} ${(err as Error).message}`);
      }
      if (!chatId) chatId = await p.text('Could not find your chat automatically. Chat id:', '');
      if (tok && chatId) {
        const r = await sendTelegram(
          {
            kind: 'test',
            level: 'info',
            title: 'Ollama Guard connected',
            message: 'You will get usage alerts here.',
            at: new Date().toISOString(),
          },
          tok,
          chatId,
        );
        console.log(
          `    ${r.ok ? sym.ok() : sym.warn()} ${r.ok ? 'Sent a test message to Telegram.' : `Telegram test failed: ${r.error}`}`,
        );
        secrets.telegramBotToken = tok;
        cfg.alerts.telegram = { enabled: true, chatId };
      }
    } else cfg.alerts.telegram.enabled = false;
    if (await p.confirm('Discord webhook alerts?', cfg.alerts.discord.enabled)) {
      const hook = (await p.secret('Discord webhook URL:')) || secrets.discordWebhookUrl || '';
      if (hook) {
        secrets.discordWebhookUrl = hook;
        cfg.alerts.discord.enabled = true;
      }
    } else cfg.alerts.discord.enabled = false;

    // 8 — Secret storage
    const keytar = await loadKeytar();
    if (keytar) {
      const store = await p.choose(
        'Where should secrets be stored?',
        [
          { value: 'keychain', label: 'OS keychain', hint: 'via keytar' },
          { value: 'file', label: '~/.ollama-guard/secrets.json', hint: 'owner-only permissions' },
        ],
        cfg.secretStore === 'file' ? 1 : 0,
      );
      cfg.secretStore = store;
    }

    saveConfig(cfg);
    const where = await saveSecrets(cfg, secrets);
    console.log(`\n  ${sym.ok()} Saved ${c.gray(paths.config)}`);
    console.log(`  ${sym.ok()} Secrets in ${c.gray(where === 'keychain' ? 'your OS keychain' : `${paths.secrets} (owner-only)`)}`);

    if (await p.confirm('Show Ollama usage in the Claude Code status line?', true)) {
      try {
        console.log(`  ${sym.ok()} Updated ${c.gray(installStatusline())}`);
      } catch (err) {
        console.log(`  ${sym.warn()} ${(err as Error).message}`);
      }
    }

    const shell = detectShell();
    console.log(`\n  ${c.bold('Next')}`);
    console.log(`  ${c.gray('1.')} Start the guard:   ${c.cyan('ollama-guard start --open')}`);
    console.log(`  ${c.gray('2.')} In the terminal where you run Claude Code (${shell}):\n`);
    for (const l of renderEnv(claudeEnvVars(cfg, secrets), shell).split('\n')) console.log(`       ${c.cyan(l)}`);
    console.log(`\n  ${c.gray('3.')} Run ${c.cyan('claude')} and check with ${c.cyan('ollama-guard doctor')}.\n`);
  } finally {
    p.close();
  }
}

function safeLoad(): GuardConfig {
  try {
    return loadConfig();
  } catch {
    return defaultConfig();
  }
}

async function loadSecretsRaw(cfg: GuardConfig): Promise<Secrets> {
  const envKey = process.env.OLLAMA_API_KEY;
  delete process.env.OLLAMA_API_KEY;
  try {
    return await loadSecrets(cfg);
  } finally {
    if (envKey !== undefined) process.env.OLLAMA_API_KEY = envKey;
  }
}

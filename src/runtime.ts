import fs from 'node:fs';
import { EventEmitter } from 'node:events';
import { AlertEngine, fallbackAlert, recoveredAlert, type Alert } from './alerts/engine.js';
import { dispatchAlert, type ChannelResult } from './alerts/channels.js';
import { paths } from './config/paths.js';
import type { GuardConfig, Secrets } from './config/schema.js';
import { writePrivateFile } from './config/store.js';
import { LogStore, type RequestLog } from './logs/store.js';
import { primaryTarget, type PlanState, type Target } from './proxy/plan.js';
import { OllamaUsageClient } from './usage/client.js';
import type { UsageSnapshot } from './usage/normalize.js';
import { UsagePoller } from './usage/poller.js';
import { VERSION } from './version.js';

export interface CircuitState {
  open: boolean;
  reason?: string;
  since?: string;
  until?: string;
  /** Provider currently serving requests while open. */
  provider?: string;
  model?: string;
  alerted?: boolean;
}

export interface GuardStatus {
  version: string;
  startedAt: string;
  account: { label: string; scope: 'self' | 'team'; keyConfigured: boolean };
  usage: UsageSnapshot | undefined;
  fallback: {
    enabled: boolean;
    chain: Array<{ name: string; type: string; model?: string }>;
    active: boolean;
    reason?: string;
    until?: string;
    provider?: string;
    model?: string;
  };
  downgrade: { enabled: boolean; active: boolean; thresholdPercent: number; example?: string };
  alerts: Alert[];
  server: { host: string; port: number; requireToken: boolean };
}

interface PersistedState {
  firedAlerts?: string[];
  usage?: UsageSnapshot;
  circuit?: CircuitState;
  alerts?: Alert[];
  pid?: number;
  port?: number;
}

export interface RuntimeEvents {
  status: [GuardStatus];
  request: [RequestLog];
  alert: [Alert, ChannelResult[]];
}

/** Holds all mutable state for a running guard: config, usage, circuit, logs. */
export class GuardRuntime extends EventEmitter<RuntimeEvents> {
  readonly startedAt = new Date().toISOString();
  readonly logs: LogStore;
  readonly poller: UsagePoller;
  private engine: AlertEngine;
  private circuit: CircuitState = { open: false };
  private recentAlerts: Alert[] = [];
  private persistTimer: NodeJS.Timeout | undefined;

  constructor(
    public config: GuardConfig,
    public secrets: Secrets,
    opts: { logsDir?: string; fetchImpl?: typeof fetch; persist?: boolean } = {},
  ) {
    super();
    this.persistEnabled = opts.persist ?? true;
    this.fetchImpl = opts.fetchImpl;
    const saved = this.persistEnabled ? readState() : {};
    this.engine = new AlertEngine(
      { thresholds: config.alerts.thresholds, onReset: config.alerts.onReset, accountLabel: config.ollama.accountLabel },
      saved.firedAlerts ?? [],
    );
    this.recentAlerts = saved.alerts ?? [];
    if (saved.circuit?.open && saved.circuit.until && Date.parse(saved.circuit.until) > Date.now()) this.circuit = saved.circuit;
    this.logs = new LogStore(opts.logsDir ?? paths.logsDir, config.logging.retentionDays);
    this.poller = new UsagePoller(this.makeClient(), config.ollama.pollIntervalSec, config.ollama.usageScope);
    if (saved.usage) this.poller.snapshot = { ...saved.usage, ok: false, error: 'Waiting for first refresh…' };
    this.poller.on('update', (snap, prev) => this.onUsage(snap, prev));
  }

  private readonly persistEnabled: boolean;
  readonly fetchImpl: typeof fetch | undefined;

  private makeClient(): OllamaUsageClient | undefined {
    if (!this.secrets.ollamaApiKey) return undefined;
    return new OllamaUsageClient({
      baseUrl: this.config.ollama.baseUrl,
      apiKey: this.secrets.ollamaApiKey,
      scope: this.config.ollama.usageScope,
      fetchImpl: this.fetchImpl,
    });
  }

  start(): void {
    this.logs.load();
    this.poller.start();
  }

  stop(): void {
    this.poller.stop();
    this.persistNow();
  }

  /** Apply new config/secrets without restarting. */
  reload(config: GuardConfig, secrets: Secrets): void {
    this.config = config;
    this.secrets = secrets;
    this.engine.setOptions({
      thresholds: config.alerts.thresholds,
      onReset: config.alerts.onReset,
      accountLabel: config.ollama.accountLabel,
    });
    this.logs.setRetention(config.logging.retentionDays);
    this.poller.reconfigure(this.makeClient(), config.ollama.pollIntervalSec, config.ollama.usageScope);
    this.emitStatus();
  }

  // ------------------------------------------------------------ plan state

  planState(): PlanState {
    if (this.circuit.open && this.circuit.until && Date.parse(this.circuit.until) <= Date.now()) this.closeCircuit('cooldown elapsed');
    return { headlineUsed: this.poller.snapshot?.headline?.used, circuitOpen: this.circuit.open };
  }

  onPrimaryLimited(reason: string, retryAfterSec?: number): void {
    const now = Date.now();
    let until = now + this.config.fallback.cooldownSec * 1000;
    if (retryAfterSec) until = Math.max(until, now + retryAfterSec * 1000);
    // If usage says we are at the limit, wait for the window's reset.
    const h = this.poller.snapshot?.headline;
    if (h && h.used >= 0.999 && h.resetsAt) {
      const r = Date.parse(h.resetsAt);
      if (!Number.isNaN(r) && r > until) until = r;
    }
    const wasOpen = this.circuit.open;
    this.circuit = {
      ...this.circuit,
      open: true,
      reason,
      since: wasOpen ? this.circuit.since : new Date(now).toISOString(),
      until: new Date(until).toISOString(),
      alerted: wasOpen ? this.circuit.alerted : false,
    };
    if (!this.config.fallback.enabled || this.config.fallback.chain.filter((p) => p.enabled !== false).length === 0) {
      // No fallback: still close the circuit soon so we keep trying Ollama.
      this.circuit.open = false;
    }
    this.schedulePersist();
    this.emitStatus();
  }

  onFallbackServed(target: Target, reason: string): void {
    const changed = this.circuit.provider !== target.name || this.circuit.model !== target.model;
    this.circuit.provider = target.name;
    this.circuit.model = target.model;
    if (this.circuit.open && !this.circuit.alerted) {
      this.circuit.alerted = true;
      if (this.config.alerts.onFallback) void this.raise(fallbackAlert(target.name, target.model, reason.replace(/^Ollama /, '')));
    }
    if (changed) this.emitStatus();
  }

  onPrimaryOk(): void {
    if (this.circuit.open) this.closeCircuit('Ollama answered');
  }

  resetCircuit(): void {
    this.closeCircuit('manual reset');
  }

  private closeCircuit(_why: string): void {
    const was = this.circuit;
    this.circuit = { open: false };
    if (was.open && was.alerted && this.config.alerts.onFallback) void this.raise(recoveredAlert());
    this.schedulePersist();
    this.emitStatus();
  }

  // ------------------------------------------------------------ usage

  private onUsage(snap: UsageSnapshot, prev: UsageSnapshot | undefined): void {
    for (const alert of this.engine.evaluate(snap, prev)) {
      if (alert.kind === 'reset' && this.circuit.open) this.closeCircuit('usage reset');
      void this.raise(alert);
    }
    // At the limit: keep the fallback until the window actually resets.
    const h = snap.headline;
    if (
      this.circuit.open &&
      h &&
      h.used >= 0.999 &&
      h.resetsAt &&
      this.circuit.until &&
      Date.parse(h.resetsAt) > Date.parse(this.circuit.until)
    )
      this.circuit.until = h.resetsAt;
    // Usage dropped below 100% and we were only waiting for the window: close early.
    if (this.circuit.open && snap.ok && snap.headline && snap.headline.used < 0.98 && prev?.headline && prev.headline.used >= 0.999)
      this.closeCircuit('usage below limit');
    this.schedulePersist();
    this.emitStatus();
  }

  async raise(alert: Alert): Promise<ChannelResult[]> {
    this.recentAlerts.unshift(alert);
    this.recentAlerts = this.recentAlerts.slice(0, 30);
    const results = await dispatchAlert(alert, this.config, this.secrets);
    this.emit('alert', alert, results);
    this.schedulePersist();
    return results;
  }

  recordRequest(entry: RequestLog): void {
    this.logs.append(entry);
    this.emit('request', entry);
  }

  // ------------------------------------------------------------ status

  status(): GuardStatus {
    const ps = this.planState();
    const sample = Object.keys(this.config.downgrade.map)[0];
    const downgradeActive = Boolean(
      this.config.downgrade.enabled && ps.headlineUsed !== undefined && ps.headlineUsed * 100 >= this.config.downgrade.thresholdPercent,
    );
    return {
      version: VERSION,
      startedAt: this.startedAt,
      account: {
        label: this.config.ollama.accountLabel,
        scope: this.config.ollama.usageScope,
        keyConfigured: Boolean(this.secrets.ollamaApiKey),
      },
      usage: this.poller.snapshot,
      fallback: {
        enabled: this.config.fallback.enabled,
        chain: this.config.fallback.chain
          .filter((p) => p.enabled !== false)
          .map((p) => ({ name: p.name, type: p.type, model: p.defaultModel })),
        active: this.circuit.open,
        reason: this.circuit.reason,
        until: this.circuit.until,
        provider: this.circuit.provider,
        model: this.circuit.model,
      },
      downgrade: {
        enabled: this.config.downgrade.enabled,
        active: downgradeActive,
        thresholdPercent: this.config.downgrade.thresholdPercent,
        example: sample ? `${sample} → ${this.config.downgrade.map[sample]}` : undefined,
      },
      alerts: this.recentAlerts.slice(0, 10),
      server: { host: this.config.server.host, port: this.config.server.port, requireToken: this.config.server.requireToken },
    };
  }

  primaryForPassthrough(): Target {
    return primaryTarget('', this.config, this.secrets, { circuitOpen: false });
  }

  private emitStatus(): void {
    this.emit('status', this.status());
  }

  private schedulePersist(): void {
    if (!this.persistEnabled || this.persistTimer) return;
    this.persistTimer = setTimeout(() => {
      this.persistTimer = undefined;
      this.persistNow();
    }, 500);
    this.persistTimer.unref?.();
  }

  persistNow(): void {
    if (!this.persistEnabled) return;
    const state: PersistedState = {
      firedAlerts: this.engine.firedKeys(),
      usage: this.poller.snapshot,
      circuit: this.circuit,
      alerts: this.recentAlerts,
      pid: process.pid,
      port: this.config.server.port,
    };
    try {
      writePrivateFile(paths.state, JSON.stringify(state, null, 2));
    } catch {
      /* non-fatal */
    }
  }
}

export function readState(): PersistedState {
  try {
    return JSON.parse(fs.readFileSync(paths.state, 'utf8')) as PersistedState;
  } catch {
    return {};
  }
}

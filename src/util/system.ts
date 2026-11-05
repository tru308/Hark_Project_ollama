import { spawn } from 'node:child_process';
import type { GuardStatus } from '../runtime.js';

export function openInBrowser(url: string): void {
  const platform = process.platform;
  const [cmd, args] =
    platform === 'win32' ? ['cmd', ['/c', 'start', '""', url]] : platform === 'darwin' ? ['open', [url]] : ['xdg-open', [url]];
  try {
    const child = spawn(cmd as string, args as string[], {
      stdio: 'ignore',
      detached: true,
      windowsHide: true,
      windowsVerbatimArguments: platform === 'win32',
    });
    child.on('error', () => undefined);
    child.unref();
  } catch {
    /* no browser available (SSH, WSL without wslview, ...) */
  }
}

export function guardUrl(host: string, port: number): string {
  const h = host === '0.0.0.0' || host === '::' ? '127.0.0.1' : host;
  return `http://${h.includes(':') ? `[${h}]` : h}:${port}`;
}

/** Ask a running guard for its status; undefined when it is not running. */
export async function fetchStatus(host: string, port: number, timeoutMs = 800): Promise<GuardStatus | undefined> {
  try {
    const res = await fetch(`${guardUrl(host, port)}/api/guard/status`, { signal: AbortSignal.timeout(timeoutMs) });
    if (!res.ok) return undefined;
    return (await res.json()) as GuardStatus;
  } catch {
    return undefined;
  }
}

export function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

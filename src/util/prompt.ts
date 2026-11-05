import readline from 'node:readline';
import { c } from './term.js';

/**
 * Small, dependency-free prompts that work in Windows Terminal, PowerShell,
 * cmd, macOS Terminal and Linux shells.
 */
export class Prompter {
  private rl: readline.Interface;
  private queue: string[] = [];
  private waiters: Array<(line: string) => void> = [];
  private closed = false;

  constructor(
    private input: NodeJS.ReadableStream = process.stdin,
    private output: NodeJS.WritableStream = process.stdout,
  ) {
    this.rl = readline.createInterface({ input, output, terminal: false });
    this.rl.on('line', (line) => {
      const w = this.waiters.shift();
      if (w) w(line);
      else this.queue.push(line);
    });
    this.rl.on('close', () => {
      this.closed = true;
      for (const w of this.waiters.splice(0)) w('');
    });
  }

  private nextLine(): Promise<string> {
    const q = this.queue.shift();
    if (q !== undefined) return Promise.resolve(q);
    if (this.closed) return Promise.resolve('');
    return new Promise((resolve) => this.waiters.push(resolve));
  }

  private write(s: string): void {
    this.output.write(s);
  }

  async text(question: string, def?: string): Promise<string> {
    this.write(`  ${c.cyan('?')} ${c.bold(question)}${def ? c.gray(` (${def})`) : ''} `);
    const answer = (await this.nextLine()).trim();
    return answer || def || '';
  }

  async confirm(question: string, def = true): Promise<boolean> {
    const hint = def ? 'Y/n' : 'y/N';
    this.write(`  ${c.cyan('?')} ${c.bold(question)} ${c.gray(`(${hint})`)} `);
    const a = (await this.nextLine()).trim().toLowerCase();
    if (!a) return def;
    return a === 'y' || a === 'yes';
  }

  async choose<T extends string>(question: string, choices: Array<{ value: T; label: string; hint?: string }>, def = 0): Promise<T> {
    this.write(`  ${c.cyan('?')} ${c.bold(question)}\n`);
    choices.forEach((ch, i) => {
      const marker = i === def ? c.cyan('›') : ' ';
      this.write(`    ${marker} ${c.bold(String(i + 1))}. ${ch.label}${ch.hint ? c.gray(`  ${ch.hint}`) : ''}\n`);
    });
    for (;;) {
      this.write(`    ${c.gray(`Choose 1-${choices.length}`)} ${c.gray(`(${def + 1})`)} `);
      const a = (await this.nextLine()).trim();
      if (!a) return (choices[def] as { value: T }).value;
      const n = Number(a);
      if (Number.isInteger(n) && n >= 1 && n <= choices.length) return (choices[n - 1] as { value: T }).value;
      const byValue = choices.find((ch) => ch.value === a);
      if (byValue) return byValue.value;
      if (this.closed) return (choices[def] as { value: T }).value;
    }
  }

  /** Read a secret without echoing it (falls back to plain input when not a TTY). */
  async secret(question: string): Promise<string> {
    const stdin = this.input as NodeJS.ReadStream;
    if (!stdin.isTTY || typeof stdin.setRawMode !== 'function') return this.text(question);
    this.write(`  ${c.cyan('?')} ${c.bold(question)} `);
    this.rl.pause();
    return new Promise((resolve) => {
      let value = '';
      stdin.setRawMode(true);
      stdin.resume();
      const onData = (buf: Buffer) => {
        for (const ch of buf.toString('utf8')) {
          if (ch === '\r' || ch === '\n') {
            stdin.setRawMode(false);
            stdin.off('data', onData);
            this.write('\n');
            this.rl.resume();
            resolve(value.trim());
            return;
          }
          if (ch === '\u0003') {
            stdin.setRawMode(false);
            this.write('\n');
            process.exit(130);
          }
          if (ch === '\u007f' || ch === '\b') {
            if (value.length) {
              value = value.slice(0, -1);
              this.write('\b \b');
            }
            continue;
          }
          value += ch;
          this.write('•');
        }
      };
      stdin.on('data', onData);
    });
  }

  close(): void {
    this.rl.close();
  }
}

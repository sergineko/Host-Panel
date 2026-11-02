import { spawn } from 'node:child_process';
import { config } from '../config.ts';

export interface ExecOptions {
  cwd?: string;
  env?: Record<string, string>;
  /** Receives output line by line (stdout and stderr). */
  onLine?: (line: string) => void;
  timeoutMs?: number;
  input?: string;
  /** Strings to hide from logged output (tokens, passwords). */
  mask?: string[];
}

export class ExecError extends Error {
  code: number | null;
  output: string;
  constructor(message: string, code: number | null, output: string) {
    super(message);
    this.code = code;
    this.output = output;
  }
}

function maskText(text: string, mask: string[] = []) {
  let out = text;
  for (const secret of mask) if (secret) out = out.split(secret).join('****');
  return out;
}

/**
 * Runs a command without a shell (arguments are passed verbatim, so no injection).
 * Resolves with combined output; rejects with ExecError on non-zero exit.
 */
export function exec(cmd: string, args: string[], opts: ExecOptions = {}): Promise<string> {
  const printable = maskText([cmd, ...args].join(' '), opts.mask);
  if (config.dev) {
    opts.onLine?.(`[dev] ${printable}`);
    return Promise.resolve('');
  }
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, {
      cwd: opts.cwd,
      env: { ...process.env, ...opts.env },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let output = '';
    let pending = '';
    const onData = (chunk: Buffer) => {
      const text = maskText(chunk.toString('utf8'), opts.mask);
      output += text;
      if (output.length > 2_000_000) output = output.slice(-1_000_000);
      if (opts.onLine) {
        pending += text;
        const lines = pending.split(/\r?\n/);
        pending = lines.pop() ?? '';
        for (const l of lines) opts.onLine(l);
      }
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    let timer: NodeJS.Timeout | undefined;
    if (opts.timeoutMs) {
      timer = setTimeout(() => child.kill('SIGKILL'), opts.timeoutMs);
    }
    child.on('error', (err) => {
      if (timer) clearTimeout(timer);
      reject(new ExecError(`${printable}: ${err.message}`, null, output));
    });
    child.on('close', (code) => {
      if (timer) clearTimeout(timer);
      if (pending && opts.onLine) opts.onLine(pending);
      if (code === 0) resolve(output);
      else reject(new ExecError(`${printable} terminó con código ${code}`, code, output));
    });
    if (opts.input !== undefined) child.stdin.end(opts.input);
    else child.stdin.end();
  });
}

/** Like exec but never throws; returns ok flag. */
export async function tryExec(cmd: string, args: string[], opts: ExecOptions = {}) {
  try {
    return { ok: true, output: await exec(cmd, args, opts) };
  } catch (err) {
    return { ok: false, output: err instanceof ExecError ? err.output : String(err) };
  }
}

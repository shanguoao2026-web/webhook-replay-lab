import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import http from 'node:http';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Capture } from '../src/types.js';

const here = path.dirname(fileURLToPath(import.meta.url));

export const root = path.resolve(here, '..');
export const cliPath = path.join(root, 'dist', 'cli.js');
export const fixturesDir = path.join(root, 'fixtures');

/** Published with the sample fixtures. Not a real provider secret. */
export const FIXTURE_SECRET = 'whsec_test_fixture_only';

export async function tempDir(): Promise<string> {
  return mkdtemp(path.join(tmpdir(), 'whr-'));
}

export async function cleanup(dir: string): Promise<void> {
  await rm(dir, { recursive: true, force: true });
}

export function sampleCapture(overrides: Partial<Capture> = {}): Capture {
  return {
    id: 'whr_test',
    timestamp: '2024-01-01T00:00:00.000Z',
    method: 'POST',
    path: '/hooks/test',
    query: '',
    headers: { 'content-type': 'application/json' },
    rawBody: '{"ok":true}',
    contentType: 'application/json',
    remoteAddr: '127.0.0.1',
    ...overrides,
  };
}

export interface CliResult {
  code: number;
  stdout: string;
  stderr: string;
}

export function runCli(args: string[], extraEnv: Record<string, string | undefined> = {}): Promise<CliResult> {
  const env = { ...process.env };
  delete env.STRIPE_WEBHOOK_SECRET;
  delete env.WEBHOOK_SECRET;
  for (const [key, value] of Object.entries(extraEnv)) {
    if (value === undefined) delete env[key];
    else env[key] = value;
  }

  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--enable-source-maps', cliPath, ...args], {
      cwd: root,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.on('data', (chunk: string) => {
      stderr += chunk;
    });
    child.on('error', reject);
    child.on('close', (code) => {
      resolve({ code: code ?? 1, stdout, stderr });
    });
  });
}

export function spawnCli(args: string[]): ChildProcessWithoutNullStreams {
  const env = { ...process.env };
  delete env.STRIPE_WEBHOOK_SECRET;
  delete env.WEBHOOK_SECRET;
  return spawn(process.execPath, ['--enable-source-maps', cliPath, ...args], {
    cwd: root,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

export function waitForText(stream: NodeJS.ReadableStream, pattern: RegExp, timeoutMs = 5000): Promise<string> {
  return new Promise((resolve, reject) => {
    let buf = '';
    const timer = setTimeout(() => {
      cleanupListeners();
      reject(new Error(`timed out waiting for ${pattern}. output so far:\n${buf}`));
    }, timeoutMs);
    const onData = (chunk: Buffer | string): void => {
      buf += chunk.toString();
      if (pattern.test(buf)) {
        cleanupListeners();
        resolve(buf);
      }
    };
    const cleanupListeners = (): void => {
      clearTimeout(timer);
      stream.off('data', onData);
    };
    stream.on('data', onData);
  });
}

export async function stopChild(child: ChildProcessWithoutNullStreams): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  await new Promise<void>((resolve) => {
    child.once('exit', () => resolve());
    child.kill('SIGTERM');
  });
}

export interface Listening {
  port: number;
  url: string;
  close: () => Promise<void>;
}

export function listen(
  handler: (req: IncomingMessage, res: ServerResponse) => void,
): Promise<Listening> {
  const server = http.createServer(handler);
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      resolve({
        port,
        url: `http://127.0.0.1:${port}`,
        close: () =>
          new Promise((res, rej) => {
            server.close((err) => (err ? rej(err) : res()));
          }),
      });
    });
  });
}

export function readIncoming(req: IncomingMessage): Promise<{ body: Buffer; headers: IncomingMessage['headers'] }> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => resolve({ body: Buffer.concat(chunks), headers: req.headers }));
    req.on('error', reject);
  });
}

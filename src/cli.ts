#!/usr/bin/env node
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Command, CommanderError } from 'commander';
import {
  DEFAULT_DIR,
  DEFAULT_HMAC_HEADER,
  DEFAULT_HMAC_PREFIX,
  DEFAULT_HOST,
  DEFAULT_MAX_BODY_BYTES,
  DEFAULT_PORT,
  DEFAULT_REPLAY_TIMEOUT_MS,
  DEFAULT_TOLERANCE_SEC,
  VERSION,
} from './constants.js';
import { diffPayloads } from './diff.js';
import { formatCapture, formatDiff, formatJson, formatList, formatReplay, formatVerify } from './format.js';
import { replayCapture } from './replay.js';
import { startServer } from './server.js';
import { ensureDir, listCaptures, readCapture } from './store.js';
import { verifyHmac, verifyStripe } from './verify.js';

interface DirOpts {
  dir: string;
}

interface ServeOpts extends DirOpts {
  port: string;
  host: string;
  ui?: boolean;
  maxBody: string;
}

interface ListOpts extends DirOpts {
  json?: boolean;
}

interface ReplayOpts extends DirOpts {
  to: string;
  preserveHeaders?: boolean;
  timeout: string;
  json?: boolean;
}

interface DiffOpts extends DirOpts {
  json?: boolean;
}

interface VerifyOpts extends DirOpts {
  provider: string;
  secret?: string;
  secretFile?: string;
  tolerance: string;
  now?: string;
  header?: string;
  prefix: string;
  json?: boolean;
}

export async function main(argv: string[]): Promise<number> {
  const outcome = { code: 0 };
  const program = new Command();

  program
    .name('webhook-replay-lab')
    .description('Record, inspect, verify, diff, and replay webhooks on your machine.')
    .version(VERSION)
    .showHelpAfterError();
  program.exitOverride();

  withDir(
    program
      .command('serve')
      .description('Listen for webhooks and store them as JSON files.')
      .option('-p, --port <port>', 'port to bind', String(DEFAULT_PORT))
      .option('--host <host>', 'interface to bind (default loopback)', DEFAULT_HOST)
      .option('--ui', 'serve the local web UI at /')
      .option('--max-body <bytes>', 'maximum captured request body', String(DEFAULT_MAX_BODY_BYTES)),
  ).action(async (opts: ServeOpts) => {
    outcome.code = await serveCommand(opts);
  });

  withDir(
    program.command('list').description('List captured webhooks, newest first.').option('--json', 'print JSON'),
  ).action(async (opts: ListOpts) => {
    outcome.code = await listCommand(opts);
  });

  withDir(program.command('show').description('Print one captured webhook.').argument('<id>', 'capture id')).action(
    async (id: string, opts: DirOpts) => {
      outcome.code = await showCommand(id, opts);
    },
  );

  withDir(
    program
      .command('replay')
      .description('Send a captured webhook to another URL.')
      .argument('<id>', 'capture id')
      .requiredOption('--to <url>', 'target URL')
      .option('--preserve-headers', 'forward the original headers, including signatures')
      .option('--timeout <ms>', 'request timeout in milliseconds', String(DEFAULT_REPLAY_TIMEOUT_MS))
      .option('--json', 'print JSON'),
  ).action(async (id: string, opts: ReplayOpts) => {
    outcome.code = await replayCommand(id, opts);
  });

  withDir(
    program
      .command('diff')
      .description('Diff the payloads of two captures.')
      .argument('<idA>', 'first capture id')
      .argument('<idB>', 'second capture id')
      .option('--json', 'print JSON'),
  ).action(async (idA: string, idB: string, opts: DiffOpts) => {
    outcome.code = await diffCommand(idA, idB, opts);
  });

  withDir(
    program
      .command('verify')
      .description('Check a Stripe-Signature or shared-secret HMAC.')
      .argument('<id>', 'capture id')
      .requiredOption('--provider <provider>', 'stripe or hmac')
      .option('--secret <secret>', 'signing secret (prefer --secret-file or an env var)')
      .option('--secret-file <path>', 'file containing the signing secret')
      .option('--tolerance <seconds>', 'Stripe age window; 0 disables the check', String(DEFAULT_TOLERANCE_SEC))
      .option('--now <unix-seconds>', 'clock override for the Stripe age check')
      .option('--header <name>', 'signature header to read')
      .option('--prefix <prefix>', 'text before the HMAC hex digest', DEFAULT_HMAC_PREFIX)
      .option('--json', 'print JSON'),
  ).action(async (id: string, opts: VerifyOpts) => {
    outcome.code = await verifyCommand(id, opts);
  });

  program.addHelpText(
    'after',
    `
Examples:
  $ webhook-replay-lab serve --port 8787 --dir ./captures --ui
  $ webhook-replay-lab list --dir ./captures
  $ webhook-replay-lab show <id> --dir ./captures
  $ webhook-replay-lab replay <id> --to http://127.0.0.1:9999/hook --dir ./captures
  $ webhook-replay-lab diff <idA> <idB> --dir ./captures
  $ webhook-replay-lab verify <id> --provider stripe --secret "$STRIPE_WEBHOOK_SECRET"

Secrets are read from --secret, --secret-file, STRIPE_WEBHOOK_SECRET, or WEBHOOK_SECRET.
The secret is never printed. Do not commit real signing secrets.
`,
  );

  if (argv.slice(2).length === 0) {
    program.outputHelp();
    return 1;
  }

  try {
    await program.parseAsync(argv);
  } catch (err) {
    if (err instanceof CommanderError) return err.exitCode;
    const message = err instanceof Error ? err.message : String(err);
    process.stderr.write(`error: ${message}\n`);
    return 1;
  }
  return outcome.code;
}

function withDir(command: Command): Command {
  return command.option('-d, --dir <dir>', 'directory of capture JSON files', DEFAULT_DIR);
}

async function serveCommand(opts: ServeOpts): Promise<number> {
  const port = parsePort(opts.port);
  const maxBodyBytes = parsePositiveInt('max-body', opts.maxBody);
  const dir = await ensureDir(opts.dir);
  const running = await startServer({
    port,
    host: opts.host,
    dir,
    ui: opts.ui === true,
    maxBodyBytes,
  });

  let stopping = false;
  await new Promise<void>((resolve) => {
    const stop = (): void => {
      if (stopping) return;
      stopping = true;
      running.close().then(
        () => resolve(),
        () => resolve(),
      );
    };
    process.once('SIGINT', stop);
    process.once('SIGTERM', stop);
    process.stdout.write(
      [
        `webhook-replay-lab listening on ${running.url}`,
        `captures: ${dir}`,
        opts.ui ? `ui: ${running.url}/` : 'ui: disabled (pass --ui)',
        'record: any path except GET /, GET /health, GET /favicon.ico, and /api/*',
        '',
      ].join('\n'),
    );
  });
  return 0;
}

async function listCommand(opts: ListOpts): Promise<number> {
  const captures = await listCaptures(opts.dir);
  process.stdout.write(opts.json ? formatJson(captures) : formatList(captures));
  return 0;
}

async function showCommand(id: string, opts: DirOpts): Promise<number> {
  const capture = await readCapture(opts.dir, id);
  process.stdout.write(formatCapture(capture));
  return 0;
}

async function replayCommand(id: string, opts: ReplayOpts): Promise<number> {
  const capture = await readCapture(opts.dir, id);
  const result = await replayCapture(capture, {
    to: opts.to,
    preserveHeaders: opts.preserveHeaders === true,
    timeoutMs: parsePositiveInt('timeout', opts.timeout),
  });
  process.stdout.write(opts.json ? formatJson(result) : formatReplay(result));
  return result.ok ? 0 : 1;
}

async function diffCommand(idA: string, idB: string, opts: DiffOpts): Promise<number> {
  const [left, right] = await Promise.all([readCapture(opts.dir, idA), readCapture(opts.dir, idB)]);
  const result = diffPayloads(left.rawBody, right.rawBody);
  process.stdout.write(opts.json ? formatJson({ idA, idB, ...result }) : formatDiff(idA, idB, result));
  return 0;
}

async function verifyCommand(id: string, opts: VerifyOpts): Promise<number> {
  const provider = parseProvider(opts.provider);
  const secret = await resolveSecret(opts, provider);
  const capture = await readCapture(opts.dir, id);
  const result =
    provider === 'stripe'
      ? verifyStripe(capture, {
          secret,
          toleranceSec: parseNonNegInt('tolerance', opts.tolerance),
          ...(opts.now === undefined ? {} : { nowSec: parseNonNegInt('now', opts.now) }),
          ...(opts.header === undefined ? {} : { headerName: opts.header }),
        })
      : verifyHmac(capture, {
          secret,
          headerName: opts.header ?? DEFAULT_HMAC_HEADER,
          prefix: opts.prefix,
        });
  process.stdout.write(opts.json ? formatJson(result) : formatVerify(result));
  return result.ok ? 0 : 1;
}

async function resolveSecret(opts: VerifyOpts, provider: 'stripe' | 'hmac'): Promise<string> {
  if (opts.secret !== undefined) {
    if (opts.secret.length === 0) throw new Error('Secret is empty.');
    return opts.secret;
  }
  if (opts.secretFile) {
    let text: string;
    try {
      text = await readFile(opts.secretFile, 'utf8');
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      throw new Error(`Could not read secret file: ${message}`);
    }
    const secret = text.replace(/^\uFEFF/, '').trim();
    if (!secret) throw new Error('Secret file is empty.');
    return secret;
  }
  const stripe = process.env.STRIPE_WEBHOOK_SECRET;
  const generic = process.env.WEBHOOK_SECRET;
  const fromEnv = provider === 'stripe' ? stripe || generic : generic || stripe;
  if (fromEnv) return fromEnv;
  throw new Error(
    'Missing secret. Pass --secret or --secret-file, or set WEBHOOK_SECRET (STRIPE_WEBHOOK_SECRET for stripe).',
  );
}

function parseProvider(value: string): 'stripe' | 'hmac' {
  const provider = value.toLowerCase();
  if (provider === 'stripe' || provider === 'hmac') return provider;
  throw new Error(`Unknown provider "${value}". Use stripe or hmac.`);
}

function parsePort(value: string): number {
  if (!/^\d+$/.test(value)) throw new Error(`Invalid port: ${value}`);
  const port = Number(value);
  if (port > 65535) throw new Error(`Invalid port: ${value}`);
  return port;
}

function parseNonNegInt(name: string, value: string): number {
  if (!/^\d+$/.test(value)) throw new Error(`Invalid ${name}: ${value}`);
  return Number(value);
}

function parsePositiveInt(name: string, value: string): number {
  const parsed = parseNonNegInt(name, value);
  if (parsed <= 0) throw new Error(`Invalid ${name}: ${value}`);
  return parsed;
}

function isMainModule(): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  return path.resolve(entry) === fileURLToPath(import.meta.url);
}

if (isMainModule()) {
  main(process.argv)
    .then((code) => {
      process.exitCode = code;
    })
    .catch((err: unknown) => {
      const message = err instanceof Error ? err.message : String(err);
      process.stderr.write(`error: ${message}\n`);
      process.exitCode = 1;
    });
}

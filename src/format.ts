import { captureBody } from './body.js';
import type { Capture, DiffResult, ReplayResult, VerifyResult } from './types.js';

export function formatList(captures: Capture[]): string {
  if (captures.length === 0) return 'No captures.\n';
  const header = ['ID', 'TIMESTAMP', 'METHOD', 'PATH', 'BYTES'];
  const rows = captures.map((capture) => [
    capture.id,
    capture.timestamp,
    capture.method,
    capture.query ? `${capture.path}?${capture.query}` : capture.path,
    String(captureBody(capture).length),
  ]);
  const widths = header.map((label, index) =>
    Math.min(72, Math.max(label.length, ...rows.map((row) => row[index]?.length ?? 0))),
  );
  const render = (cols: string[]): string =>
    cols
      .map((col, index) => {
        const width = widths[index] ?? col.length;
        const cell = col.length > width ? `${col.slice(0, Math.max(1, width - 1))}…` : col;
        return index === cols.length - 1 ? cell : cell.padEnd(width);
      })
      .join('  ');
  return [render(header), ...rows.map(render)].join('\n') + '\n';
}

export function formatCapture(capture: Capture): string {
  return JSON.stringify(capture, null, 2) + '\n';
}

export function formatDiff(idA: string, idB: string, result: DiffResult): string {
  const lines = [
    `diff ${idA} ${idB}`,
    `format: ${result.format}`,
    `equal: ${result.equal}`,
  ];
  if (result.entries.length === 0) {
    lines.push('no differences');
    return lines.join('\n') + '\n';
  }
  lines.push(`changes: ${result.entries.length}`, '');
  for (const entry of result.entries) {
    const mark = entry.kind === 'added' ? '+' : entry.kind === 'removed' ? '-' : '~';
    lines.push(`${mark} ${entry.path} (${entry.kind})`);
    if (entry.kind !== 'added') lines.push(`    left:  ${preview(entry.left)}`);
    if (entry.kind !== 'removed') lines.push(`    right: ${preview(entry.right)}`);
  }
  return lines.join('\n') + '\n';
}

export function formatVerify(result: VerifyResult): string {
  const lines = [`${result.ok ? 'valid' : 'invalid'}  provider=${result.provider}`];
  if (result.timestamp !== undefined) lines.push(`timestamp: ${result.timestamp}`);
  lines.push(result.reason);
  return lines.join('\n') + '\n';
}

export function formatReplay(result: ReplayResult): string {
  const lines = [
    `id: ${result.id}`,
    `target: ${result.target}`,
    `ok: ${result.ok}`,
    `status: ${result.status ?? '-'}`,
  ];
  if (result.error) lines.push(`error: ${result.error}`);
  if (result.body) {
    lines.push('');
    lines.push(result.body.length > 2000 ? `${result.body.slice(0, 2000)}\n…` : result.body);
  }
  return lines.join('\n') + '\n';
}

export function formatJson(value: unknown): string {
  return JSON.stringify(value, null, 2) + '\n';
}

function preview(value: unknown): string {
  const text = typeof value === 'string' ? JSON.stringify(value) : JSON.stringify(value);
  if (text === undefined) return 'undefined';
  return text.length > 240 ? `${text.slice(0, 240)}…` : text;
}

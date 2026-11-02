import type { Capture } from './types.js';

const SKIP = new Set(['host', 'content-length', 'connection', 'transfer-encoding', 'keep-alive']);

export function toCurl(capture: Capture, targetUrl: string): string {
  const headerArgs: string[] = [];
  for (const name of Object.keys(capture.headers).sort()) {
    if (SKIP.has(name.toLowerCase())) continue;
    const value = capture.headers[name];
    if (value === undefined) continue;
    const joined = Array.isArray(value) ? value.join(', ') : value;
    headerArgs.push('-H', shellQuote(`${name}: ${joined}`));
  }

  const request = ['curl', '-sS', '-X', capture.method.toUpperCase(), ...headerArgs];
  if (capture.bodyEncoding === 'base64') {
    return `printf '%s' ${shellQuote(capture.rawBody)} | base64 -d | ${request.join(' ')} --data-binary @- ${shellQuote(targetUrl)}`;
  }

  if (capture.rawBody && capture.method.toUpperCase() !== 'GET' && capture.method.toUpperCase() !== 'HEAD') {
    request.push('--data-binary', shellQuote(capture.rawBody));
  }
  request.push(shellQuote(targetUrl));
  return request.join(' ');
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

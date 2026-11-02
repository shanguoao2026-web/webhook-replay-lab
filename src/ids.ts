import { randomBytes } from 'node:crypto';

const ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;

export function isSafeId(id: string): boolean {
  return ID_PATTERN.test(id);
}

export function assertSafeId(id: string): void {
  if (!isSafeId(id)) {
    throw new Error('Invalid capture id.');
  }
}

export function createId(now = Date.now()): string {
  return `whr_${now.toString(36)}_${randomBytes(4).toString('hex')}`;
}

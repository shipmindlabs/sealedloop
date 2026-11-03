import { createHash } from 'node:crypto';

export interface Tombstone {
  readonly erasedAt: string;
  readonly by: string;
}

export interface PresentText {
  readonly status: 'PRESENT';
  readonly digest: string;
  readonly text: string;
}

export interface ErasedText {
  readonly status: 'ERASED';
  readonly digest: string;
  readonly erasedAt: string;
  readonly by: string;
}

export interface MissingText {
  readonly status: 'MISSING';
  readonly digest: string;
}

export type TextRead = PresentText | ErasedText | MissingText;

export type TextResolver = (digest: string) => TextRead;

export function digestOf(text: string): string {
  return createHash('sha256').update(text.normalize('NFC'), 'utf8').digest('hex');
}

export function presentText(digest: string, text: string): PresentText {
  return Object.freeze({ status: 'PRESENT' as const, digest, text });
}

export function erasedText(digest: string, tombstone: Tombstone): ErasedText {
  return Object.freeze({
    status: 'ERASED' as const,
    digest,
    erasedAt: tombstone.erasedAt,
    by: tombstone.by,
  });
}

export function missingText(digest: string): MissingText {
  return Object.freeze({ status: 'MISSING' as const, digest });
}

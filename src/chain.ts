import { createHash, randomBytes } from 'node:crypto';

import { canonicalize } from './canonical.ts';
import type { Rating } from './rating.ts';
import type { Competency } from './rubric.ts';
import type { Scorecard } from './scorecard.ts';

export const SALT_BYTES = 32;

export interface ChainEntry {
  readonly seq: number;
  readonly prev: string | null;
  readonly kind: string;
  readonly body: Readonly<Record<string, unknown>>;
  readonly hash: string;
}

export type ChainCheck =
  | { readonly ok: true }
  | { readonly ok: false; readonly firstBroken: number };

export function hashEntry(
  seq: number,
  prev: string | null,
  kind: string,
  body: Readonly<Record<string, unknown>>,
): string {
  return createHash('sha256').update(canonicalize({ seq, prev, kind, body }), 'utf8').digest('hex');
}

export function nextEntry(
  entries: readonly ChainEntry[],
  kind: string,
  body: Readonly<Record<string, unknown>>,
): ChainEntry {
  const seq = entries.length;
  const prev = entries[seq - 1]?.hash ?? null;
  return deepFreeze({ seq, prev, kind, body, hash: hashEntry(seq, prev, kind, body) });
}

export function verifyChain(entries: readonly ChainEntry[]): ChainCheck {
  let prev: string | null = null;
  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index];
    if (entry === undefined || !holds(entry, index, prev)) {
      const broken: ChainCheck = { ok: false, firstBroken: index };
      return Object.freeze(broken);
    }
    prev = entry.hash;
  }
  const intact: ChainCheck = { ok: true };
  return Object.freeze(intact);
}

export function newSalt(): Uint8Array {
  return randomBytes(SALT_BYTES);
}

export function commitmentOf(card: Scorecard, salt: Uint8Array): string {
  return createHash('sha256')
    .update(salt)
    .update(canonicalize(skeletonOf(card)), 'utf8')
    .digest('hex');
}

export function digestOf(text: string): string {
  return createHash('sha256').update(text.normalize('NFC'), 'utf8').digest('hex');
}

function skeletonOf(card: Scorecard): Record<string, unknown> {
  return {
    loopId: card.loopId,
    candidateRef: card.candidateRef,
    interviewerId: card.interviewerId,
    rubricHash: card.rubricHash,
    levels: card.rubric.competencies.map((competency) => {
      const rating = card.ratings[competency.id];
      return {
        competencyId: competency.id,
        rating: rating ?? null,
        level: levelOf(competency, rating),
      };
    }),
    evidence: card.evidence.map((note) => ({
      competencyId: note.competencyId,
      digest: digestOf(note.text),
    })),
  };
}

function levelOf(competency: Competency, rating: Rating | undefined): number | null {
  return competency.anchors.find((anchor) => anchor.id === rating)?.level ?? null;
}

function holds(entry: ChainEntry, index: number, prev: string | null): boolean {
  if (entry.seq !== index || entry.prev !== prev || typeof entry.hash !== 'string') {
    return false;
  }
  try {
    return entry.hash === hashEntry(entry.seq, entry.prev, entry.kind, entry.body);
  } catch {
    return false;
  }
}

function deepFreeze<T>(value: T): T {
  if (typeof value === 'object' && value !== null) {
    for (const inner of Object.values(value as object)) {
      deepFreeze(inner);
    }
    Object.freeze(value);
  }
  return value;
}

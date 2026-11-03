import type { ChainEntry } from './chain.ts';
import type { Scorecard } from './scorecard.ts';
import { erasedText, missingText, presentText } from './vault.ts';
import type { TextRead, Tombstone } from './vault.ts';

export interface Assignment {
  readonly candidateRef: string;
  readonly interviewerIds: readonly string[];
  readonly displayNameDigest: string | null;
}

export interface Recusal {
  readonly candidateRef: string;
  readonly interviewerId: string;
  readonly reasonDigest: string;
}

export interface CommitSeal {
  readonly candidateRef: string;
  readonly interviewerId: string;
  readonly seq: number;
  readonly salt: Uint8Array;
}

export interface Retention {
  readonly candidateRef: string;
  readonly until: string;
}

export interface Store {
  readAssignment(candidateRef: string): Assignment | undefined;
  writeAssignment(assignment: Assignment): void;
  readCards(candidateRef: string): readonly Scorecard[];
  writeCard(card: Scorecard): void;
  readRecusals(candidateRef: string): readonly Recusal[];
  writeRecusal(recusal: Recusal): void;
  readChain(candidateRef: string): readonly ChainEntry[];
  appendEntry(candidateRef: string, entry: ChainEntry): void;
  readSeal(candidateRef: string, interviewerId: string): CommitSeal | undefined;
  writeSeal(seal: CommitSeal): void;
  readText(candidateRef: string, digest: string): TextRead;
  // A digest already in the vault keeps the record it has, so a tombstone never reopens.
  writeText(candidateRef: string, digest: string, text: string): void;
  listTexts(candidateRef: string): readonly TextRead[];
  eraseText(candidateRef: string, digest: string, tombstone: Tombstone): void;
  writeRetention(retention: Retention): void;
  listRetentions(): readonly Retention[];
}

export class MemoryStore implements Store {
  readonly #assignments = new Map<string, Assignment>();
  readonly #cards = new Map<string, Scorecard[]>();
  readonly #recusals = new Map<string, Recusal[]>();
  readonly #chains = new Map<string, ChainEntry[]>();
  readonly #seals = new Map<string, CommitSeal>();
  readonly #texts = new Map<string, Map<string, TextRead>>();
  readonly #retentions = new Map<string, Retention>();

  readAssignment(candidateRef: string): Assignment | undefined {
    return this.#assignments.get(candidateRef);
  }

  writeAssignment(assignment: Assignment): void {
    this.#assignments.set(assignment.candidateRef, assignment);
  }

  readCards(candidateRef: string): readonly Scorecard[] {
    return [...(this.#cards.get(candidateRef) ?? [])];
  }

  writeCard(card: Scorecard): void {
    append(this.#cards, card.candidateRef, card);
  }

  readRecusals(candidateRef: string): readonly Recusal[] {
    return [...(this.#recusals.get(candidateRef) ?? [])];
  }

  writeRecusal(recusal: Recusal): void {
    append(this.#recusals, recusal.candidateRef, recusal);
  }

  readChain(candidateRef: string): readonly ChainEntry[] {
    return [...(this.#chains.get(candidateRef) ?? [])];
  }

  appendEntry(candidateRef: string, entry: ChainEntry): void {
    append(this.#chains, candidateRef, entry);
  }

  readSeal(candidateRef: string, interviewerId: string): CommitSeal | undefined {
    return this.#seals.get(sealKey(candidateRef, interviewerId));
  }

  writeSeal(seal: CommitSeal): void {
    this.#seals.set(sealKey(seal.candidateRef, seal.interviewerId), seal);
  }

  readText(candidateRef: string, digest: string): TextRead {
    return this.#texts.get(candidateRef)?.get(digest) ?? missingText(digest);
  }

  writeText(candidateRef: string, digest: string, text: string): void {
    const vault = this.#vault(candidateRef);
    if (vault.has(digest)) {
      return;
    }
    vault.set(digest, presentText(digest, text));
  }

  listTexts(candidateRef: string): readonly TextRead[] {
    return [...(this.#texts.get(candidateRef)?.values() ?? [])];
  }

  eraseText(candidateRef: string, digest: string, tombstone: Tombstone): void {
    const vault = this.#vault(candidateRef);
    const kept = vault.get(digest);
    if (kept === undefined || kept.status === 'ERASED') {
      return;
    }
    vault.set(digest, erasedText(digest, tombstone));
  }

  writeRetention(retention: Retention): void {
    this.#retentions.set(retention.candidateRef, retention);
  }

  listRetentions(): readonly Retention[] {
    return [...this.#retentions.values()];
  }

  #vault(candidateRef: string): Map<string, TextRead> {
    const kept = this.#texts.get(candidateRef);
    if (kept !== undefined) {
      return kept;
    }
    const vault = new Map<string, TextRead>();
    this.#texts.set(candidateRef, vault);
    return vault;
  }
}

function sealKey(candidateRef: string, interviewerId: string): string {
  return `${candidateRef}\u0000${interviewerId}`;
}

function append<T>(kept: Map<string, T[]>, key: string, value: T): void {
  const list = kept.get(key);
  if (list === undefined) {
    kept.set(key, [value]);
    return;
  }
  list.push(value);
}

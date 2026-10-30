import type { ChainEntry } from './chain.ts';
import type { Scorecard } from './scorecard.ts';

export interface Assignment {
  readonly candidateRef: string;
  readonly interviewerIds: readonly string[];
}

export interface Recusal {
  readonly candidateRef: string;
  readonly interviewerId: string;
  readonly reason: string;
}

export interface CommitSeal {
  readonly candidateRef: string;
  readonly interviewerId: string;
  readonly seq: number;
  readonly salt: Uint8Array;
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
}

export class MemoryStore implements Store {
  readonly #assignments = new Map<string, Assignment>();
  readonly #cards = new Map<string, Scorecard[]>();
  readonly #recusals = new Map<string, Recusal[]>();
  readonly #chains = new Map<string, ChainEntry[]>();
  readonly #seals = new Map<string, CommitSeal>();

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

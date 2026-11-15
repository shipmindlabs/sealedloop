import type { ChainEntry } from './chain.ts';
import type { Rating } from './rating.ts';
import type { Scorecard } from './scorecard.ts';
import { erasedText, missingText, presentText } from './vault.ts';
import type { TextRead, Tombstone } from './vault.ts';

export type Resolution = 'meets-bar' | 'below-bar';

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

export interface Reveal {
  readonly candidateRef: string;
  readonly openedBy: string;
  readonly revealedAt: string;
}

export interface Amendment {
  readonly candidateRef: string;
  readonly cardId: string;
  readonly interviewerId: string;
  readonly competencyId: string;
  readonly level: Rating;
  readonly by: string;
  readonly reasonDigest: string;
  readonly afterReveal: true;
  readonly seq: number;
}

export interface Arbitration {
  readonly candidateRef: string;
  readonly competencyId: string;
  readonly by: string;
  readonly resolution: Resolution;
  readonly reasonDigest: string;
  readonly seq: number;
}

export interface Retention {
  readonly candidateRef: string;
  readonly until: string;
}

export interface Store {
  readAssignment(candidateRef: string): Assignment | undefined;
  writeAssignment(assignment: Assignment): void;
  readCards(candidateRef: string): readonly Scorecard[];
  readCardById(cardId: string): Scorecard | undefined;
  writeCard(card: Scorecard): void;
  readRecusals(candidateRef: string): readonly Recusal[];
  writeRecusal(recusal: Recusal): void;
  readChain(candidateRef: string): readonly ChainEntry[];
  appendEntry(candidateRef: string, entry: ChainEntry): void;
  readSeal(candidateRef: string, interviewerId: string): CommitSeal | undefined;
  writeSeal(seal: CommitSeal): void;
  readReveal(candidateRef: string): Reveal | undefined;
  // The first reveal is the one that freezes, so a later one leaves it as it stands.
  writeReveal(reveal: Reveal): void;
  readAmendments(candidateRef: string): readonly Amendment[];
  writeAmendment(amendment: Amendment): void;
  readArbitrations(candidateRef: string): readonly Arbitration[];
  writeArbitration(arbitration: Arbitration): void;
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
  readonly #cardsById = new Map<string, Scorecard>();
  readonly #recusals = new Map<string, Recusal[]>();
  readonly #chains = new Map<string, ChainEntry[]>();
  readonly #seals = new Map<string, CommitSeal>();
  readonly #reveals = new Map<string, Reveal>();
  readonly #amendments = new Map<string, Amendment[]>();
  readonly #arbitrations = new Map<string, Arbitration[]>();
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

  readCardById(cardId: string): Scorecard | undefined {
    return this.#cardsById.get(cardId);
  }

  writeCard(card: Scorecard): void {
    append(this.#cards, card.candidateRef, card);
    this.#cardsById.set(card.cardId, card);
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

  readReveal(candidateRef: string): Reveal | undefined {
    return this.#reveals.get(candidateRef);
  }

  writeReveal(reveal: Reveal): void {
    if (this.#reveals.has(reveal.candidateRef)) {
      return;
    }
    this.#reveals.set(reveal.candidateRef, reveal);
  }

  readAmendments(candidateRef: string): readonly Amendment[] {
    return [...(this.#amendments.get(candidateRef) ?? [])];
  }

  writeAmendment(amendment: Amendment): void {
    append(this.#amendments, amendment.candidateRef, amendment);
  }

  readArbitrations(candidateRef: string): readonly Arbitration[] {
    return [...(this.#arbitrations.get(candidateRef) ?? [])];
  }

  writeArbitration(arbitration: Arbitration): void {
    append(this.#arbitrations, arbitration.candidateRef, arbitration);
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

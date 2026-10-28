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

export interface Store {
  readAssignment(candidateRef: string): Assignment | undefined;
  writeAssignment(assignment: Assignment): void;
  readCards(candidateRef: string): readonly Scorecard[];
  writeCard(card: Scorecard): void;
  readRecusals(candidateRef: string): readonly Recusal[];
  writeRecusal(recusal: Recusal): void;
}

export class MemoryStore implements Store {
  readonly #assignments = new Map<string, Assignment>();
  readonly #cards = new Map<string, Scorecard[]>();
  readonly #recusals = new Map<string, Recusal[]>();

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
}

function append<T>(kept: Map<string, T[]>, key: string, value: T): void {
  const list = kept.get(key);
  if (list === undefined) {
    kept.set(key, [value]);
    return;
  }
  list.push(value);
}

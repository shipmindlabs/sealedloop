import { SealedLoopError } from './errors.ts';
import { assertSameRubric } from './rubric.ts';
import { checkSubmittable } from './scorecard.ts';
import type { Scorecard } from './scorecard.ts';
import { MemoryStore } from './store.ts';
import type { Assignment, Recusal, Store } from './store.ts';

export type ViewerRole = 'interviewer' | 'hiring-manager';

export interface Viewer {
  readonly id: string;
  readonly role?: ViewerRole;
}

export type ViewerRef = string | Viewer;

export interface SealedView {
  readonly status: 'SEALED';
  readonly interviewerId: string;
}

export interface PendingView {
  readonly status: 'PENDING';
  readonly interviewerId: string;
}

export interface SubmittedView {
  readonly status: 'SUBMITTED';
  readonly interviewerId: string;
  readonly card: Scorecard;
}

export interface RecusedView {
  readonly status: 'RECUSED';
  readonly interviewerId: string;
  readonly reason: string;
}

export type CardView = SealedView | PendingView | SubmittedView | RecusedView;

export interface Debrief {
  readonly candidateRef: string;
  readonly openedBy: string;
  readonly rubricHash: string | null;
  readonly cards: readonly Scorecard[];
  readonly recusals: readonly Recusal[];
}

export interface LoopOptions {
  readonly loopId: string;
  readonly store?: Store;
}

export class Loop {
  readonly loopId: string;
  readonly #store: Store;

  constructor(options: LoopOptions) {
    this.loopId = requireText(options.loopId, 'loopId', 'INVALID_LOOP');
    this.#store = options.store ?? new MemoryStore();
  }

  assign(candidateRef: string, interviewerIds: readonly string[]): Assignment {
    const ref = requireText(candidateRef, 'candidateRef', 'INVALID_ASSIGNMENT');
    if (this.#store.readAssignment(ref) !== undefined) {
      throw new SealedLoopError(
        'ALREADY_ASSIGNED',
        `${ref} already has a panel; a panel is assigned once`,
      );
    }
    if (!Array.isArray(interviewerIds) || interviewerIds.length === 0) {
      throw new SealedLoopError('INVALID_ASSIGNMENT', 'interviewerIds must be a non-empty array');
    }
    const ids: string[] = [];
    for (const raw of interviewerIds) {
      const id = requireText(raw, 'interviewerId', 'INVALID_ASSIGNMENT');
      if (ids.includes(id)) {
        throw new SealedLoopError(
          'INVALID_ASSIGNMENT',
          `${id} is named twice on the panel for ${ref}`,
        );
      }
      ids.push(id);
    }
    const assignment: Assignment = Object.freeze({
      candidateRef: ref,
      interviewerIds: Object.freeze(ids),
    });
    this.#store.writeAssignment(assignment);
    return assignment;
  }

  submit(card: Scorecard): Scorecard {
    const loopId = requireText(card.loopId, 'loopId', 'INVALID_SCORECARD');
    const interviewerId = requireText(card.interviewerId, 'interviewerId', 'INVALID_SCORECARD');
    if (loopId !== this.loopId) {
      throw new SealedLoopError('WRONG_LOOP', `the card belongs to ${loopId}, not to ${this.loopId}`);
    }
    const assignment = this.#panel(card.candidateRef);
    const ref = assignment.candidateRef;
    if (!assignment.interviewerIds.includes(interviewerId)) {
      throw new SealedLoopError('NOT_ASSIGNED', `${interviewerId} is not on the panel for ${ref}`);
    }
    if (this.#recusalOf(ref, interviewerId) !== undefined) {
      throw new SealedLoopError(
        'RECUSED',
        `${interviewerId} recused from ${ref}; a recusal is final`,
      );
    }
    if (this.#cardOf(ref, interviewerId) !== undefined) {
      throw new SealedLoopError(
        'ALREADY_SUBMITTED',
        `${interviewerId} already submitted a card for ${ref}`,
      );
    }
    checkSubmittable(card);
    assertSameRubric([...this.#store.readCards(ref), card]);
    this.#store.writeCard(card);
    return card;
  }

  recuse(interviewerId: string, candidateRef: string, reason: string): Recusal {
    const id = requireText(interviewerId, 'interviewerId', 'INVALID_RECUSAL');
    const assignment = this.#panel(candidateRef);
    const ref = assignment.candidateRef;
    if (!assignment.interviewerIds.includes(id)) {
      throw new SealedLoopError('NOT_ASSIGNED', `${id} is not on the panel for ${ref}`);
    }
    if (this.#recusalOf(ref, id) !== undefined) {
      throw new SealedLoopError('RECUSED', `${id} already recused from ${ref}; a recusal is final`);
    }
    if (this.#cardOf(ref, id) !== undefined) {
      throw new SealedLoopError(
        'ALREADY_SUBMITTED',
        `${id} already submitted a card for ${ref} and cannot withdraw it`,
      );
    }
    const recusal: Recusal = Object.freeze({
      candidateRef: ref,
      interviewerId: id,
      reason: requireText(reason, 'reason', 'INVALID_RECUSAL'),
    });
    this.#store.writeRecusal(recusal);
    return recusal;
  }

  readCards(viewer: ViewerRef, candidateRef: string): readonly CardView[] {
    const assignment = this.#panel(candidateRef);
    const viewerId = viewerIdOf(viewer);
    const cards = this.#store.readCards(assignment.candidateRef);
    const recusals = this.#store.readRecusals(assignment.candidateRef);
    const viewerIsIn =
      cards.some((filed) => filed.interviewerId === viewerId) ||
      recusals.some((filed) => filed.interviewerId === viewerId);
    const views = assignment.interviewerIds.map((interviewerId): CardView => {
      if (!viewerIsIn && interviewerId !== viewerId) {
        const sealed: SealedView = { status: 'SEALED', interviewerId };
        return Object.freeze(sealed);
      }
      const card = cards.find((filed) => filed.interviewerId === interviewerId);
      if (card !== undefined) {
        const submitted: SubmittedView = { status: 'SUBMITTED', interviewerId, card };
        return Object.freeze(submitted);
      }
      const recusal = recusals.find((filed) => filed.interviewerId === interviewerId);
      if (recusal !== undefined) {
        const recused: RecusedView = { status: 'RECUSED', interviewerId, reason: recusal.reason };
        return Object.freeze(recused);
      }
      const pending: PendingView = { status: 'PENDING', interviewerId };
      return Object.freeze(pending);
    });
    return Object.freeze(views);
  }

  openDebrief(candidateRef: string, by: ViewerRef): Debrief {
    const assignment = this.#panel(candidateRef);
    const openedBy = viewerIdOf(by);
    const cards = this.#store.readCards(assignment.candidateRef);
    const recusals = this.#store.readRecusals(assignment.candidateRef);
    const waiting = assignment.interviewerIds.filter(
      (interviewerId) =>
        !cards.some((filed) => filed.interviewerId === interviewerId) &&
        !recusals.some((filed) => filed.interviewerId === interviewerId),
    );
    if (waiting.length > 0) {
      throw new SealedLoopError(
        'NOT_ALL_IN',
        `${waiting.join(', ')} ${waiting.length === 1 ? 'has' : 'have'} neither submitted nor recused for ${assignment.candidateRef}`,
      );
    }
    const debrief: Debrief = {
      candidateRef: assignment.candidateRef,
      openedBy,
      rubricHash: cards.length === 0 ? null : assertSameRubric(cards),
      cards: Object.freeze([...cards]),
      recusals: Object.freeze([...recusals]),
    };
    return Object.freeze(debrief);
  }

  #panel(candidateRef: unknown): Assignment {
    const ref = typeof candidateRef === 'string' ? candidateRef.normalize('NFC') : '';
    const assignment = this.#store.readAssignment(ref);
    if (assignment === undefined) {
      throw new SealedLoopError(
        'UNKNOWN_CANDIDATE',
        `no panel is assigned for ${display(candidateRef)}`,
      );
    }
    return assignment;
  }

  #cardOf(candidateRef: string, interviewerId: string): Scorecard | undefined {
    return this.#store.readCards(candidateRef).find((card) => card.interviewerId === interviewerId);
  }

  #recusalOf(candidateRef: string, interviewerId: string): Recusal | undefined {
    return this.#store
      .readRecusals(candidateRef)
      .find((recusal) => recusal.interviewerId === interviewerId);
  }
}

function viewerIdOf(viewer: ViewerRef): string {
  const id = typeof viewer === 'string' ? viewer : viewer.id;
  return requireText(id, 'viewer id', 'INVALID_VIEWER');
}

function requireText(value: unknown, field: string, code: string): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new SealedLoopError(code, `${field} must be a non-empty string`);
  }
  return value.normalize('NFC');
}

function display(value: unknown): string {
  return typeof value === 'string' ? JSON.stringify(value) : String(value);
}

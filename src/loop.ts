import { commitmentOf, newSalt, nextEntry, verifyChain } from './chain.ts';
import type { ChainEntry } from './chain.ts';
import { SealedLoopError } from './errors.ts';
import { evaluateRule } from './outcome.ts';
import type { AgendaItem, CompetencyTrace } from './outcome.ts';
import { NOT_ASSESSED } from './rating.ts';
import type { Rating } from './rating.ts';
import { assertSameRubric } from './rubric.ts';
import type { Competency, Rubric } from './rubric.ts';
import {
  checkSubmittable,
  freezeAfterReveal,
  readDraftText,
  redactScorecard,
  resolveRating,
} from './scorecard.ts';
import type { Scorecard } from './scorecard.ts';
import { MemoryStore } from './store.ts';
import type {
  Amendment,
  Arbitration,
  Assignment,
  Recusal,
  Resolution,
  Retention,
  Reveal,
  Store,
} from './store.ts';
import { digestOf } from './vault.ts';
import type { TextRead, TextResolver, Tombstone } from './vault.ts';

export type ViewerRole = 'interviewer' | 'hiring-manager';

export interface Viewer {
  readonly id: string;
  readonly role?: ViewerRole;
}

export type ViewerRef = string | Viewer;

export interface AssignOptions {
  readonly displayName?: string;
}

export interface AmendRequest {
  readonly by: string;
  readonly reason: string;
}

export interface ArbitrateRequest {
  readonly by: string;
  readonly resolution: Resolution;
  readonly reason: string;
}

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
  readonly reason: TextRead;
}

export type CardView = SealedView | PendingView | SubmittedView | RecusedView;

export interface ErasureRequest {
  readonly by: string;
  readonly reason: string;
  readonly at?: string | Date;
}

export interface Erasure {
  readonly candidateRef: string;
  readonly by: string;
  readonly erasedAt: string;
  readonly digests: readonly string[];
}

export interface Debrief {
  readonly candidateRef: string;
  readonly openedBy: string;
  readonly rubricHash: string | null;
  readonly cards: readonly Scorecard[];
  readonly recusals: readonly Recusal[];
  readonly chain: readonly ChainEntry[];
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

  assign(
    candidateRef: string,
    interviewerIds: readonly string[],
    options: AssignOptions = {},
  ): Assignment {
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
    const displayName =
      options.displayName === undefined
        ? null
        : requireText(options.displayName, 'displayName', 'INVALID_ASSIGNMENT');
    const displayNameDigest = displayName === null ? null : digestOf(displayName);
    const assignment: Assignment = Object.freeze({
      candidateRef: ref,
      interviewerIds: Object.freeze(ids),
      displayNameDigest,
    });
    this.#store.writeAssignment(assignment);
    if (displayName !== null && displayNameDigest !== null) {
      this.#store.writeText(ref, displayNameDigest, displayName);
    }
    this.#append(ref, 'assign', {
      candidateRef: ref,
      interviewerIds: [...ids],
      displayNameDigest,
    });
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
    const reveal = this.#store.readReveal(ref);
    if (reveal !== undefined) {
      throw new SealedLoopError(
        'FROZEN_AFTER_REVEAL',
        `the cards for ${ref} were revealed at ${reveal.revealedAt}; file an amendment instead of a card`,
      );
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
    checkSubmittable(card, this.#resolver(ref, card));
    assertSameRubric([...this.#store.readCards(ref), card]);
    const filed = redactScorecard(card);
    const salt = newSalt();
    const entry = this.#append(ref, 'commit', {
      candidateRef: ref,
      interviewerId,
      commitment: commitmentOf(filed, salt),
    });
    this.#store.writeSeal(Object.freeze({ candidateRef: ref, interviewerId, seq: entry.seq, salt }));
    for (const note of filed.evidence) {
      const read = readDraftText(card, note.digest);
      if (read.status === 'PRESENT') {
        this.#store.writeText(ref, note.digest, read.text);
      }
    }
    this.#store.writeCard(filed);
    return filed;
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
    const text = requireText(reason, 'reason', 'INVALID_RECUSAL');
    const reasonDigest = digestOf(text);
    const recusal: Recusal = Object.freeze({ candidateRef: ref, interviewerId: id, reasonDigest });
    this.#store.writeRecusal(recusal);
    this.#store.writeText(ref, reasonDigest, text);
    this.#append(ref, 'recuse', { candidateRef: ref, interviewerId: id, reasonDigest });
    return recusal;
  }

  amend(
    cardId: string,
    competencyId: string,
    level: Rating,
    request: AmendRequest,
  ): Amendment {
    const card = this.#card(cardId);
    const assignment = this.#panel(card.candidateRef);
    const ref = assignment.candidateRef;
    const by = requireText(request.by, 'by', 'INVALID_AMENDMENT');
    if (by !== card.interviewerId) {
      throw new SealedLoopError(
        'NOT_AUTHOR',
        `${by} did not write the card ${card.interviewerId} filed for ${ref}`,
      );
    }
    if (this.#store.readReveal(ref) === undefined) {
      throw new SealedLoopError(
        'NOT_REVEALED',
        `the cards for ${ref} have not been revealed; a filed card stands until the debrief opens`,
      );
    }
    const reason = requireText(request.reason, 'reason', 'INVALID_AMENDMENT');
    const resolved = resolveRating(card.rubric, competencyId, level);
    const reasonDigest = digestOf(reason);
    const entry = this.#append(ref, 'amend', {
      candidateRef: ref,
      cardId: card.cardId,
      interviewerId: card.interviewerId,
      competencyId: resolved.competencyId,
      level: resolved.rating,
      by,
      reasonDigest,
      afterReveal: true,
    });
    this.#store.writeText(ref, reasonDigest, reason);
    const amendment: Amendment = Object.freeze({
      candidateRef: ref,
      cardId: card.cardId,
      interviewerId: card.interviewerId,
      competencyId: resolved.competencyId,
      level: resolved.rating,
      by,
      reasonDigest,
      afterReveal: true as const,
      seq: entry.seq,
    });
    this.#store.writeAmendment(amendment);
    return amendment;
  }

  currentRatings(cardId: string): Readonly<Record<string, Rating>> {
    const card = this.#card(cardId);
    const ratings: Record<string, Rating> = { ...card.ratings };
    for (const amendment of this.#store.readAmendments(card.candidateRef)) {
      if (amendment.cardId === card.cardId) {
        ratings[amendment.competencyId] = amendment.level;
      }
    }
    return Object.freeze(ratings);
  }

  amendmentsAfterReveal(candidateRef: string): readonly Amendment[] {
    const assignment = this.#panel(candidateRef);
    return Object.freeze(
      this.#store
        .readAmendments(assignment.candidateRef)
        .filter((amendment) => amendment.afterReveal),
    );
  }

  arbitrate(
    candidateRef: string,
    competencyId: string,
    request: ArbitrateRequest,
  ): Arbitration {
    const assignment = this.#panel(candidateRef);
    const ref = assignment.candidateRef;
    if (this.#store.readReveal(ref) === undefined) {
      throw new SealedLoopError(
        'NOT_REVEALED',
        `the cards for ${ref} have not been revealed; a split is read at the debrief`,
      );
    }
    const by = requireText(request.by, 'by', 'INVALID_ARBITRATION');
    const reason = requireText(request.reason, 'reason', 'INVALID_ARBITRATION');
    const resolution = request.resolution;
    if (resolution !== 'meets-bar' && resolution !== 'below-bar') {
      throw new SealedLoopError(
        'INVALID_ARBITRATION',
        `resolution must be meets-bar or below-bar, not ${display(resolution)}`,
      );
    }
    const cards = this.#store.readCards(ref);
    const rubric = cards[0]?.rubric;
    if (rubric === undefined) {
      throw new SealedLoopError(
        'INVALID_ARBITRATION',
        `no card was filed for ${ref}; there is nothing to arbitrate`,
      );
    }
    const competency = competencyOf(rubric, competencyId);
    if (this.#recusalOf(ref, by) !== undefined) {
      throw new SealedLoopError(
        'ARBITER_INVOLVED',
        `${by} recused from ${ref} and cannot arbitrate ${competency.id}`,
      );
    }
    const own = cards.find((card) => card.interviewerId === by);
    const rated = own === undefined ? undefined : this.currentRatings(own.cardId)[competency.id];
    if (rated !== undefined && rated !== NOT_ASSESSED) {
      throw new SealedLoopError(
        'ARBITER_INVOLVED',
        `${by} rated ${competency.id} for ${ref} and cannot arbitrate it`,
      );
    }
    const reasonDigest = digestOf(reason);
    const entry = this.#append(ref, 'arbitrate', {
      candidateRef: ref,
      competencyId: competency.id,
      by,
      resolution,
      reasonDigest,
    });
    this.#store.writeText(ref, reasonDigest, reason);
    const arbitration: Arbitration = Object.freeze({
      candidateRef: ref,
      competencyId: competency.id,
      by,
      resolution,
      reasonDigest,
      seq: entry.seq,
    });
    this.#store.writeArbitration(arbitration);
    return arbitration;
  }

  arbitrations(candidateRef: string): readonly Arbitration[] {
    const assignment = this.#panel(candidateRef);
    return Object.freeze([...this.#store.readArbitrations(assignment.candidateRef)]);
  }

  debriefAgenda(candidateRef: string): readonly AgendaItem[] {
    const trace = evaluateRule(this, candidateRef).trace;
    const items = [
      ...trace.gates.map((gate) => agendaItem(gate, gate.reason === 'ARBITRATION_REQUIRED')),
      ...trace.observed.map((seen) => agendaItem(seen, false)),
    ];
    items.sort(byWidestGap);
    return Object.freeze(items);
  }

  readCards(viewer: ViewerRef, candidateRef: string): readonly CardView[] {
    const assignment = this.#panel(candidateRef);
    const ref = assignment.candidateRef;
    const viewerId = viewerIdOf(viewer);
    const cards = this.#store.readCards(ref);
    const recusals = this.#store.readRecusals(ref);
    const revealedAt = this.#store.readReveal(ref)?.revealedAt ?? null;
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
        const submitted: SubmittedView = {
          status: 'SUBMITTED',
          interviewerId,
          card: revealedAt === null ? card : freezeAfterReveal(card, revealedAt),
        };
        return Object.freeze(submitted);
      }
      const recusal = recusals.find((filed) => filed.interviewerId === interviewerId);
      if (recusal !== undefined) {
        const recused: RecusedView = {
          status: 'RECUSED',
          interviewerId,
          reason: this.#store.readText(ref, recusal.reasonDigest),
        };
        return Object.freeze(recused);
      }
      const pending: PendingView = { status: 'PENDING', interviewerId };
      return Object.freeze(pending);
    });
    return Object.freeze(views);
  }

  revealedCards(candidateRef: string): readonly Scorecard[] {
    const assignment = this.#panel(candidateRef);
    const ref = assignment.candidateRef;
    const reveal = this.#store.readReveal(ref);
    if (reveal === undefined) {
      throw new SealedLoopError(
        'NOT_REVEALED',
        `the cards for ${ref} have not been revealed; open the debrief before reading the panel`,
      );
    }
    return Object.freeze(
      this.#store.readCards(ref).map((card) => freezeAfterReveal(card, reveal.revealedAt)),
    );
  }

  readText(candidateRef: string, digest: string): TextRead {
    const assignment = this.#panel(candidateRef);
    return this.#store.readText(
      assignment.candidateRef,
      requireText(digest, 'digest', 'INVALID_DIGEST'),
    );
  }

  readDisplayName(candidateRef: string): TextRead | undefined {
    const assignment = this.#panel(candidateRef);
    const digest = assignment.displayNameDigest;
    return digest === null
      ? undefined
      : this.#store.readText(assignment.candidateRef, digest);
  }

  eraseCandidate(candidateRef: string, request: ErasureRequest): Erasure {
    const assignment = this.#panel(candidateRef);
    const ref = assignment.candidateRef;
    const by = requireText(request.by, 'by', 'INVALID_ERASURE');
    const reason = requireText(request.reason, 'reason', 'INVALID_ERASURE');
    const erasedAt = requireInstant(request.at ?? new Date(), 'at', 'INVALID_ERASURE');
    const tombstone: Tombstone = Object.freeze({ erasedAt, by });
    const kept = this.#store.listTexts(ref);
    for (const read of kept) {
      if (read.status === 'PRESENT') {
        this.#store.eraseText(ref, read.digest, tombstone);
      }
    }
    const digests = kept.map((read) => read.digest).sort();
    this.#append(ref, 'erasure', {
      candidateRef: ref,
      by,
      reasonDigest: digestOf(reason),
      erasedAt,
      digests: [...digests],
    });
    const erasure: Erasure = { candidateRef: ref, by, erasedAt, digests: Object.freeze(digests) };
    return Object.freeze(erasure);
  }

  setRetention(candidateRef: string, until: string | Date): Retention {
    const assignment = this.#panel(candidateRef);
    const retention: Retention = Object.freeze({
      candidateRef: assignment.candidateRef,
      until: requireInstant(until, 'until', 'INVALID_RETENTION'),
    });
    this.#store.writeRetention(retention);
    return retention;
  }

  dueForErasure(now: string | Date = new Date()): readonly Retention[] {
    const at = Date.parse(requireInstant(now, 'now', 'INVALID_RETENTION'));
    const due = this.#store
      .listRetentions()
      .filter(
        (retention) =>
          Date.parse(retention.until) <= at &&
          this.#store
            .listTexts(retention.candidateRef)
            .some((read) => read.status === 'PRESENT'),
      )
      .sort(byUntil);
    return Object.freeze(due);
  }

  chain(candidateRef: string): readonly ChainEntry[] {
    const assignment = this.#panel(candidateRef);
    return Object.freeze([...this.#store.readChain(assignment.candidateRef)]);
  }

  openDebrief(candidateRef: string, by: ViewerRef): Debrief {
    const assignment = this.#panel(candidateRef);
    const ref = assignment.candidateRef;
    const openedBy = viewerIdOf(by);
    const cards = this.#store.readCards(ref);
    const recusals = this.#store.readRecusals(ref);
    const waiting = assignment.interviewerIds.filter(
      (interviewerId) =>
        !cards.some((filed) => filed.interviewerId === interviewerId) &&
        !recusals.some((filed) => filed.interviewerId === interviewerId),
    );
    if (waiting.length > 0) {
      throw new SealedLoopError(
        'NOT_ALL_IN',
        `${waiting.join(', ')} ${waiting.length === 1 ? 'has' : 'have'} neither submitted nor recused for ${ref}`,
      );
    }
    const chain = this.#store.readChain(ref);
    const check = verifyChain(chain);
    if (!check.ok) {
      throw new SealedLoopError(
        'TAMPERED',
        `the chain for ${ref} breaks at entry ${check.firstBroken}`,
      );
    }
    for (const card of cards) {
      this.#recheck(ref, card, chain);
    }
    const revealedAt = this.#markRevealed(ref, openedBy);
    const revealed = cards.map((card) => freezeAfterReveal(card, revealedAt));
    const debrief: Debrief = {
      candidateRef: ref,
      openedBy,
      rubricHash: revealed.length === 0 ? null : assertSameRubric(revealed),
      cards: Object.freeze(revealed),
      recusals: Object.freeze([...recusals]),
      chain: Object.freeze([...chain]),
    };
    return Object.freeze(debrief);
  }

  #markRevealed(candidateRef: string, openedBy: string): string {
    const kept = this.#store.readReveal(candidateRef);
    if (kept !== undefined) {
      return kept.revealedAt;
    }
    const reveal: Reveal = Object.freeze({
      candidateRef,
      openedBy,
      revealedAt: new Date().toISOString(),
    });
    this.#store.writeReveal(reveal);
    return reveal.revealedAt;
  }

  #resolver(candidateRef: string, card: Scorecard): TextResolver {
    return (digest) => {
      const stored = this.#store.readText(candidateRef, digest);
      return stored.status === 'MISSING' ? readDraftText(card, digest) : stored;
    };
  }

  #recheck(candidateRef: string, card: Scorecard, chain: readonly ChainEntry[]): void {
    const seal = this.#store.readSeal(candidateRef, card.interviewerId);
    if (seal === undefined) {
      throw new SealedLoopError(
        'TAMPERED',
        `the card ${card.interviewerId} filed for ${candidateRef} has no commitment behind it`,
      );
    }
    const entry = chain.find((filed) => filed.seq === seal.seq);
    const stored = entry?.kind === 'commit' ? entry.body['commitment'] : undefined;
    const committed = typeof stored === 'string' ? stored : '';
    if (committed !== commitmentOf(card, seal.salt)) {
      throw new SealedLoopError(
        'TAMPERED',
        `the card ${card.interviewerId} filed for ${candidateRef} no longer matches the commitment at entry ${seal.seq}`,
      );
    }
  }

  #append(candidateRef: string, kind: string, body: Readonly<Record<string, unknown>>): ChainEntry {
    const entry = nextEntry(this.#store.readChain(candidateRef), kind, body);
    this.#store.appendEntry(candidateRef, entry);
    return entry;
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

  #card(cardId: unknown): Scorecard {
    const id = typeof cardId === 'string' ? cardId.normalize('NFC') : '';
    const card = this.#store.readCardById(id);
    if (card === undefined) {
      throw new SealedLoopError('UNKNOWN_CARD', `no card is filed under ${display(cardId)}`);
    }
    return card;
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

function agendaItem(trace: CompetencyTrace, needsArbitration: boolean): AgendaItem {
  const item: AgendaItem = {
    competencyId: trace.competencyId,
    mustHave: trace.mustHave,
    spread: trace.spread,
    split: trace.split,
    counted: trace.counted,
    needsArbitration,
  };
  return Object.freeze(item);
}

function byWidestGap(left: AgendaItem, right: AgendaItem): number {
  if (left.spread !== right.spread) {
    return right.spread - left.spread;
  }
  if (left.competencyId < right.competencyId) {
    return -1;
  }
  return left.competencyId > right.competencyId ? 1 : 0;
}

function competencyOf(rubric: Rubric, competencyId: unknown): Competency {
  const id = typeof competencyId === 'string' ? competencyId.normalize('NFC') : '';
  const competency = rubric.competencies.find((candidate) => candidate.id === id);
  if (competency === undefined) {
    throw new SealedLoopError(
      'UNKNOWN_COMPETENCY',
      `${display(competencyId)} is not a competency of this rubric`,
    );
  }
  return competency;
}

function viewerIdOf(viewer: ViewerRef): string {
  const id = typeof viewer === 'string' ? viewer : viewer.id;
  return requireText(id, 'viewer id', 'INVALID_VIEWER');
}

function byUntil(left: Retention, right: Retention): number {
  const first = `${left.until}\u0000${left.candidateRef}`;
  const second = `${right.until}\u0000${right.candidateRef}`;
  if (first < second) {
    return -1;
  }
  return first > second ? 1 : 0;
}

function requireInstant(value: unknown, field: string, code: string): string {
  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) {
      throw new SealedLoopError(code, `${field} must be a valid date`);
    }
    return value.toISOString();
  }
  if (typeof value === 'string') {
    const parsed = Date.parse(value);
    if (Number.isNaN(parsed)) {
      throw new SealedLoopError(code, `${field} must be an ISO 8601 instant`);
    }
    return new Date(parsed).toISOString();
  }
  throw new SealedLoopError(code, `${field} must be an ISO 8601 instant or a Date`);
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

import type { Loop } from './loop.ts';
import { NOT_ASSESSED } from './rating.ts';
import type { Rating } from './rating.ts';
import { assertSameRubric } from './rubric.ts';
import type { Competency } from './rubric.ts';
import { anchorPosition } from './scorecard.ts';
import type { Scorecard } from './scorecard.ts';
import type { Arbitration, Resolution } from './store.ts';

export const MIN_RATINGS_PER_MUST_HAVE = 2;

export const MIN_ARBITRATION_SPREAD = 2;

export type RuleStatus = 'meets-rule' | 'below-rule' | 'blocked';

export type GateStatus = 'meets-bar' | 'below-bar' | 'blocked';

export type BlockedReason = 'UNASSESSED_MUST_HAVE' | 'PANEL_TOO_SMALL' | 'ARBITRATION_REQUIRED';

export interface RatingTrace {
  readonly interviewerId: string;
  readonly cardId: string;
  readonly rating: Rating;
  readonly level: number | null;
  readonly amended: boolean;
}

export interface ArbitrationTrace {
  readonly by: string;
  readonly resolution: Resolution;
  readonly reasonDigest: string;
  readonly seq: number;
}

export interface CompetencyTrace {
  readonly competencyId: string;
  readonly mustHave: boolean;
  readonly bar: number;
  readonly lowerMedian: number | null;
  readonly spread: number;
  readonly split: boolean;
  readonly counted: readonly number[];
  readonly notAssessedBy: readonly string[];
  readonly ratings: readonly RatingTrace[];
}

export interface GateTrace extends CompetencyTrace {
  readonly status: GateStatus;
  readonly reason: BlockedReason | null;
  readonly arbitration: ArbitrationTrace | null;
}

export interface AgendaItem {
  readonly competencyId: string;
  readonly mustHave: boolean;
  readonly spread: number;
  readonly split: boolean;
  readonly counted: readonly number[];
  readonly needsArbitration: boolean;
}

export interface RuleTrace {
  readonly rule: 'non-compensatory-gates';
  readonly minRatings: number;
  readonly rubricHash: string | null;
  readonly submittedBy: readonly string[];
  readonly gates: readonly GateTrace[];
  readonly observed: readonly CompetencyTrace[];
}

export interface RuleOutcome {
  readonly candidateRef: string;
  readonly status: RuleStatus;
  readonly trace: RuleTrace;
}

export function evaluateRule(loop: Loop, candidateRef: string): RuleOutcome {
  const cards = loop.revealedCards(candidateRef);
  const ref = cards[0]?.candidateRef ?? candidateRef.normalize('NFC');
  const moved = movedLevels(loop, ref);
  const settled = settledGates(loop, ref);
  const current = new Map(cards.map((card) => [card.cardId, loop.currentRatings(card.cardId)]));
  const gates: GateTrace[] = [];
  const observed: CompetencyTrace[] = [];
  for (const competency of cards[0]?.rubric.competencies ?? []) {
    const trace = traceOf(competency, cards, current, moved);
    if (competency.mustHave) {
      gates.push(judge(trace, settled.get(trace.competencyId)));
    } else {
      observed.push(trace);
    }
  }
  const trace: RuleTrace = {
    rule: 'non-compensatory-gates',
    minRatings: MIN_RATINGS_PER_MUST_HAVE,
    rubricHash: cards.length === 0 ? null : assertSameRubric(cards),
    submittedBy: Object.freeze(cards.map((card) => card.interviewerId)),
    gates: Object.freeze(gates),
    observed: Object.freeze(observed),
  };
  const outcome: RuleOutcome = {
    candidateRef: ref,
    status: statusOf(cards, gates),
    trace: Object.freeze(trace),
  };
  return Object.freeze(outcome);
}

function statusOf(cards: readonly Scorecard[], gates: readonly GateTrace[]): RuleStatus {
  if (cards.length === 0 || gates.some((gate) => gate.status === 'blocked')) {
    return 'blocked';
  }
  return gates.some((gate) => gate.status === 'below-bar') ? 'below-rule' : 'meets-rule';
}

function judge(trace: CompetencyTrace, arbitration: Arbitration | undefined): GateTrace {
  if (trace.counted.length < MIN_RATINGS_PER_MUST_HAVE) {
    const blocked: GateTrace = {
      ...trace,
      status: 'blocked',
      reason: trace.notAssessedBy.length > 0 ? 'UNASSESSED_MUST_HAVE' : 'PANEL_TOO_SMALL',
      arbitration: null,
    };
    return Object.freeze(blocked);
  }
  if (arbitration !== undefined) {
    const settled: GateTrace = {
      ...trace,
      status: arbitration.resolution,
      reason: null,
      arbitration: Object.freeze({
        by: arbitration.by,
        resolution: arbitration.resolution,
        reasonDigest: arbitration.reasonDigest,
        seq: arbitration.seq,
      }),
    };
    return Object.freeze(settled);
  }
  if (trace.spread >= MIN_ARBITRATION_SPREAD || trace.split) {
    const held: GateTrace = {
      ...trace,
      status: 'blocked',
      reason: 'ARBITRATION_REQUIRED',
      arbitration: null,
    };
    return Object.freeze(held);
  }
  const judged: GateTrace = {
    ...trace,
    status: trace.lowerMedian !== null && trace.lowerMedian >= trace.bar ? 'meets-bar' : 'below-bar',
    reason: null,
    arbitration: null,
  };
  return Object.freeze(judged);
}

function traceOf(
  competency: Competency,
  cards: readonly Scorecard[],
  current: Map<string, Readonly<Record<string, Rating>>>,
  moved: Set<string>,
): CompetencyTrace {
  const ratings: RatingTrace[] = [];
  const counted: number[] = [];
  const notAssessedBy: string[] = [];
  for (const card of cards) {
    const rating = current.get(card.cardId)?.[competency.id] ?? NOT_ASSESSED;
    const level = rating === NOT_ASSESSED ? null : anchorPosition(rating, competency);
    const filed: RatingTrace = {
      interviewerId: card.interviewerId,
      cardId: card.cardId,
      rating,
      level,
      amended: moved.has(movedKey(card.cardId, competency.id)),
    };
    ratings.push(Object.freeze(filed));
    if (level === null) {
      notAssessedBy.push(card.interviewerId);
    } else {
      counted.push(level);
    }
  }
  counted.sort((left, right) => left - right);
  const lowest = counted[0];
  const highest = counted[counted.length - 1];
  const trace: CompetencyTrace = {
    competencyId: competency.id,
    mustHave: competency.mustHave,
    bar: competency.bar,
    lowerMedian: lowerMedianOf(counted),
    spread: lowest === undefined || highest === undefined ? 0 : highest - lowest,
    split:
      counted.some((level) => level < competency.bar) &&
      counted.some((level) => level >= competency.bar),
    counted: Object.freeze(counted),
    notAssessedBy: Object.freeze(notAssessedBy),
    ratings: Object.freeze(ratings),
  };
  return Object.freeze(trace);
}

function lowerMedianOf(sorted: readonly number[]): number | null {
  if (sorted.length === 0) {
    return null;
  }
  return sorted[Math.floor((sorted.length - 1) / 2)] ?? null;
}

function movedLevels(loop: Loop, candidateRef: string): Set<string> {
  const moved = new Set<string>();
  for (const amendment of loop.amendmentsAfterReveal(candidateRef)) {
    moved.add(movedKey(amendment.cardId, amendment.competencyId));
  }
  return moved;
}

function settledGates(loop: Loop, candidateRef: string): Map<string, Arbitration> {
  const settled = new Map<string, Arbitration>();
  for (const arbitration of loop.arbitrations(candidateRef)) {
    settled.set(arbitration.competencyId, arbitration);
  }
  return settled;
}

function movedKey(cardId: string, competencyId: string): string {
  return `${cardId}\u0000${competencyId}`;
}

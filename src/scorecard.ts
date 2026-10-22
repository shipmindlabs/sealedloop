import { SealedLoopError } from './errors.ts';
import { NOT_ASSESSED } from './rating.ts';
import type { Rating } from './rating.ts';
import type { Competency, Rubric } from './rubric.ts';

export interface ScorecardIdentity {
  readonly loopId: string;
  readonly candidateRef: string;
  readonly interviewerId: string;
}

export interface EvidenceNote {
  readonly competencyId: string;
  readonly text: string;
}

export interface Scorecard {
  readonly rubric: Rubric;
  readonly rubricHash: string;
  readonly loopId: string;
  readonly candidateRef: string;
  readonly interviewerId: string;
  readonly ratings: Readonly<Record<string, Rating>>;
  readonly evidence: readonly EvidenceNote[];
}

export function draftScorecard(rubric: Rubric, identity: ScorecardIdentity): Scorecard {
  if (typeof rubric.rubricHash !== 'string' || rubric.rubricHash === '') {
    throw new SealedLoopError('MISSING_RUBRIC_HASH', 'the rubric carries no rubricHash');
  }
  return freezeCard({
    rubric,
    rubricHash: rubric.rubricHash,
    loopId: requireText(identity.loopId, 'loopId'),
    candidateRef: requireText(identity.candidateRef, 'candidateRef'),
    interviewerId: requireText(identity.interviewerId, 'interviewerId'),
    ratings: {},
    evidence: [],
  });
}

export function setRating(card: Scorecard, competencyId: string, rating: Rating): Scorecard {
  const competency = requireCompetency(card.rubric, competencyId);
  const value = typeof rating === 'string' ? rating.normalize('NFC') : rating;
  if (value !== NOT_ASSESSED && !competency.anchors.some((anchor) => anchor.id === value)) {
    throw new SealedLoopError(
      'OFF_SCALE',
      `${display(rating)} is not an anchor of ${competency.id}; rate on an anchor id or NOT_ASSESSED`,
    );
  }
  return freezeCard({ ...card, ratings: { ...card.ratings, [competency.id]: value } });
}

export function addEvidence(card: Scorecard, competencyId: string, text: string): Scorecard {
  const competency = requireCompetency(card.rubric, competencyId);
  if (typeof text !== 'string') {
    throw new SealedLoopError(
      'INVALID_EVIDENCE',
      `evidence for ${competency.id} must be a string`,
    );
  }
  const note = { competencyId: competency.id, text: text.normalize('NFC') };
  return freezeCard({ ...card, evidence: [...card.evidence, note] });
}

export function checkSubmittable(card: Scorecard): void {
  const minChars = card.rubric.minEvidenceChars;
  for (const competency of card.rubric.competencies) {
    const rating = card.ratings[competency.id];
    if (rating === undefined) {
      throw new SealedLoopError(
        'MISSING_RATING',
        `${competency.id} has no rating; an unrated competency must say ${NOT_ASSESSED}`,
      );
    }
    const edge = edgeName(competency, rating);
    if (edge === null) {
      continue;
    }
    const backed = card.evidence.some(
      (note) => note.competencyId === competency.id && countChars(note.text) >= minChars,
    );
    if (!backed) {
      throw new SealedLoopError(
        'EVIDENCE_REQUIRED',
        `${competency.id} rests on the ${edge} anchor ${rating} with no evidence note of ${minChars} characters or more`,
      );
    }
  }
}

export function anchorPosition(rating: Rating, competency?: Competency): number | null {
  if (rating === NOT_ASSESSED) {
    return null;
  }
  if (competency === undefined) {
    throw new SealedLoopError(
      'UNKNOWN_COMPETENCY',
      `placing ${display(rating)} needs the competency it was rated on`,
    );
  }
  const anchor = competency.anchors.find((candidate) => candidate.id === rating);
  if (anchor === undefined) {
    throw new SealedLoopError(
      'OFF_SCALE',
      `${display(rating)} is not an anchor of ${competency.id}`,
    );
  }
  return anchor.level;
}

function edgeName(competency: Competency, rating: Rating): string | null {
  if (rating === NOT_ASSESSED) {
    return null;
  }
  const anchors = competency.anchors;
  if (anchors[anchors.length - 1]?.id === rating) {
    return 'top';
  }
  return anchors[0]?.id === rating ? 'bottom' : null;
}

function countChars(text: string): number {
  return [...text.trim()].length;
}

function requireCompetency(rubric: Rubric, competencyId: unknown): Competency {
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

function requireText(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new SealedLoopError('INVALID_SCORECARD', `${field} must be a non-empty string`);
  }
  return value.normalize('NFC');
}

function display(value: unknown): string {
  return typeof value === 'string' ? JSON.stringify(value) : String(value);
}

function freezeCard(card: Scorecard): Scorecard {
  Object.freeze(card.ratings);
  for (const note of card.evidence) {
    Object.freeze(note);
  }
  Object.freeze(card.evidence);
  return Object.freeze(card);
}

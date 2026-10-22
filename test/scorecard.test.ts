import assert from 'node:assert/strict';
import { test } from 'node:test';

import { SealedLoopError } from '../src/errors.ts';
import { NOT_ASSESSED } from '../src/rating.ts';
import { createRubric } from '../src/rubric.ts';
import type { Rubric } from '../src/rubric.ts';
import {
  addEvidence,
  anchorPosition,
  checkSubmittable,
  draftScorecard,
  setRating,
} from '../src/scorecard.ts';
import type { Scorecard } from '../src/scorecard.ts';

const NOTE = 'Designed for failure, load and rollback on the whiteboard.';
const EXACTLY_TWENTY = 'Named two tradeoffs.';
const NINETEEN = 'Named the tradeoff.';

function rubric(): Rubric {
  return createRubric({
    role: 'Backend Engineer',
    minEvidenceChars: 20,
    competencies: [
      {
        id: 'systems-design',
        mustHave: true,
        bar: 3,
        anchors: [
          {
            id: 'sd-novice',
            level: 1,
            label: 'Novice',
            description: 'Sketches one service and stops there.',
          },
          {
            id: 'sd-working',
            level: 2,
            label: 'Working',
            description: 'Weighs two designs and names the tradeoff.',
          },
          {
            id: 'sd-strong',
            level: 3,
            label: 'Strong',
            description: 'Designs for failure, load and rollback.',
          },
        ],
      },
      {
        id: 'collaboration',
        mustHave: false,
        bar: 2,
        anchors: [
          {
            id: 'co-novice',
            level: 1,
            label: 'Novice',
            description: 'Answers questions only when asked.',
          },
          {
            id: 'co-working',
            level: 2,
            label: 'Working',
            description: 'Surfaces disagreement early, in writing.',
          },
        ],
      },
    ],
  });
}

function draft(of: Rubric = rubric()): Scorecard {
  return draftScorecard(of, {
    loopId: 'loop-14',
    candidateRef: 'cand-7',
    interviewerId: 'eng-3',
  });
}

function refusal(block: () => unknown, code: string): void {
  assert.throws(block, (error: unknown) => error instanceof SealedLoopError && error.code === code);
}

test('a draft card is stamped with the rubric hash and the identity', () => {
  const of = rubric();
  const card = draft(of);
  assert.equal(card.rubricHash, of.rubricHash);
  assert.equal(card.loopId, 'loop-14');
  assert.equal(card.candidateRef, 'cand-7');
  assert.equal(card.interviewerId, 'eng-3');
  assert.deepEqual(card.ratings, {});
  assert.deepEqual(card.evidence, []);
});

test('an identity with a blank field is refused', () => {
  refusal(
    () => draftScorecard(rubric(), { loopId: ' ', candidateRef: 'cand-7', interviewerId: 'eng-3' }),
    'INVALID_SCORECARD',
  );
});

test('a card is frozen and every change returns a new card', () => {
  const card = draft();
  assert.ok(Object.isFrozen(card));
  assert.ok(Object.isFrozen(card.ratings));
  assert.throws(() => {
    (card as { loopId: string }).loopId = 'loop-15';
  }, TypeError);
  const rated = setRating(card, 'systems-design', 'sd-working');
  assert.equal(rated.ratings['systems-design'], 'sd-working');
  assert.equal(card.ratings['systems-design'], undefined);
  const noted = addEvidence(rated, 'systems-design', NOTE);
  assert.equal(noted.evidence.length, 1);
  assert.equal(rated.evidence.length, 0);
});

test('setRating takes an anchor id of that competency or NOT_ASSESSED', () => {
  const card = setRating(setRating(draft(), 'systems-design', 'sd-strong'), 'collaboration', NOT_ASSESSED);
  assert.equal(card.ratings['systems-design'], 'sd-strong');
  assert.equal(card.ratings['collaboration'], NOT_ASSESSED);
});

test('a level number is off the scale', () => {
  const card = draft();
  refusal(() => setRating(card, 'systems-design', 3 as unknown as string), 'OFF_SCALE');
  refusal(() => setRating(card, 'systems-design', '3'), 'OFF_SCALE');
});

test('an unknown anchor and an anchor of another competency are off the scale', () => {
  const card = draft();
  refusal(() => setRating(card, 'systems-design', 'sd-brilliant'), 'OFF_SCALE');
  refusal(() => setRating(card, 'systems-design', 'co-working'), 'OFF_SCALE');
});

test('an unknown competency is named as such', () => {
  const card = draft();
  refusal(() => setRating(card, 'vibes', 'sd-strong'), 'UNKNOWN_COMPETENCY');
  refusal(() => addEvidence(card, 'vibes', NOTE), 'UNKNOWN_COMPETENCY');
});

test('silence is not NOT_ASSESSED', () => {
  const card = setRating(draft(), 'systems-design', 'sd-working');
  refusal(() => checkSubmittable(card), 'MISSING_RATING');
});

test('a middle anchor needs no evidence and NOT_ASSESSED needs none either', () => {
  const card = setRating(
    setRating(draft(), 'systems-design', 'sd-working'),
    'collaboration',
    NOT_ASSESSED,
  );
  checkSubmittable(card);
});

test('a top or bottom anchor without evidence is refused', () => {
  const base = setRating(draft(), 'collaboration', NOT_ASSESSED);
  refusal(() => checkSubmittable(setRating(base, 'systems-design', 'sd-strong')), 'EVIDENCE_REQUIRED');
  refusal(() => checkSubmittable(setRating(base, 'systems-design', 'sd-novice')), 'EVIDENCE_REQUIRED');
  checkSubmittable(addEvidence(setRating(base, 'systems-design', 'sd-strong'), 'systems-design', NOTE));
});

test('whitespace-only evidence does not back an edge anchor', () => {
  const card = addEvidence(
    setRating(setRating(draft(), 'systems-design', 'sd-strong'), 'collaboration', NOT_ASSESSED),
    'systems-design',
    '   \n\t   ',
  );
  refusal(() => checkSubmittable(card), 'EVIDENCE_REQUIRED');
});

test('evidence filed under another competency does not count', () => {
  const card = addEvidence(
    setRating(setRating(draft(), 'systems-design', 'sd-strong'), 'collaboration', NOT_ASSESSED),
    'collaboration',
    NOTE,
  );
  refusal(() => checkSubmittable(card), 'EVIDENCE_REQUIRED');
});

test('evidence is measured after trimming, against minEvidenceChars', () => {
  const base = setRating(
    setRating(draft(), 'systems-design', 'sd-strong'),
    'collaboration',
    NOT_ASSESSED,
  );
  refusal(
    () => checkSubmittable(addEvidence(base, 'systems-design', NINETEEN)),
    'EVIDENCE_REQUIRED',
  );
  refusal(
    () => checkSubmittable(addEvidence(base, 'systems-design', `   ${NINETEEN}   `)),
    'EVIDENCE_REQUIRED',
  );
  checkSubmittable(addEvidence(base, 'systems-design', `  ${EXACTLY_TWENTY}  `));
});

test('both edge anchors of a two-anchor competency need evidence', () => {
  const base = setRating(draft(), 'systems-design', 'sd-working');
  refusal(() => checkSubmittable(setRating(base, 'collaboration', 'co-working')), 'EVIDENCE_REQUIRED');
  refusal(() => checkSubmittable(setRating(base, 'collaboration', 'co-novice')), 'EVIDENCE_REQUIRED');
});

test('NOT_ASSESSED has no position, so it cannot sort below the lowest anchor', () => {
  const competency = rubric().competencies[0]!;
  assert.equal(anchorPosition(NOT_ASSESSED), null);
  assert.equal(anchorPosition('sd-novice', competency), 1);
  assert.equal(anchorPosition('sd-strong', competency), 3);
  refusal(() => anchorPosition('co-working', competency), 'OFF_SCALE');
  refusal(() => anchorPosition('sd-strong'), 'UNKNOWN_COMPETENCY');
});

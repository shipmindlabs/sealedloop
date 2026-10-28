import assert from 'node:assert/strict';
import { test } from 'node:test';

import { SealedLoopError } from '../src/errors.ts';
import { Loop } from '../src/loop.ts';
import type { CardView } from '../src/loop.ts';
import { NOT_ASSESSED } from '../src/rating.ts';
import { createRubric, reviseRubric } from '../src/rubric.ts';
import type { Rubric } from '../src/rubric.ts';
import { addEvidence, draftScorecard, setRating } from '../src/scorecard.ts';
import type { Scorecard } from '../src/scorecard.ts';
import { MemoryStore } from '../src/store.ts';

const NOTE = 'Designed for failure, load and rollback on the whiteboard.';
const REASON = 'I managed this candidate for two years.';

function rubric(): Rubric {
  return createRubric({
    role: 'Backend Engineer',
    minEvidenceChars: 20,
    competencies: [
      {
        id: 'systems-design',
        mustHave: true,
        bar: 2,
        anchors: [
          { id: 'sd-novice', level: 1, label: 'Novice', description: 'Sketches one service.' },
          { id: 'sd-working', level: 2, label: 'Working', description: 'Names the tradeoff.' },
          { id: 'sd-strong', level: 3, label: 'Strong', description: 'Designs for failure.' },
        ],
      },
      {
        id: 'collaboration',
        mustHave: false,
        bar: 2,
        anchors: [
          { id: 'co-novice', level: 1, label: 'Novice', description: 'Answers when asked.' },
          { id: 'co-working', level: 2, label: 'Working', description: 'Writes disagreement.' },
        ],
      },
    ],
  });
}

function card(of: Rubric, interviewerId: string, loopId = 'loop-14'): Scorecard {
  const drafted = draftScorecard(of, { loopId, candidateRef: 'cand-7', interviewerId });
  const rated = setRating(
    setRating(drafted, 'systems-design', 'sd-strong'),
    'collaboration',
    NOT_ASSESSED,
  );
  return addEvidence(rated, 'systems-design', NOTE);
}

function loop(): Loop {
  const panel = new Loop({ loopId: 'loop-14', store: new MemoryStore() });
  panel.assign('cand-7', ['eng-3', 'eng-4', 'eng-5']);
  return panel;
}

function statuses(views: readonly CardView[]): readonly string[] {
  return views.map((view) => view.status);
}

function refusal(block: () => unknown, code: string): void {
  assert.throws(block, (error: unknown) => error instanceof SealedLoopError && error.code === code);
}

test('a panel is assigned once, with ids that are checked', () => {
  const panel = new Loop({ loopId: 'loop-14' });
  const assignment = panel.assign('cand-7', ['eng-3', 'eng-4']);
  assert.deepEqual(assignment.interviewerIds, ['eng-3', 'eng-4']);
  assert.ok(Object.isFrozen(assignment.interviewerIds));
  refusal(() => panel.assign('cand-7', ['eng-9']), 'ALREADY_ASSIGNED');
  refusal(() => panel.assign(' ', ['eng-3']), 'INVALID_ASSIGNMENT');
  refusal(() => panel.assign('cand-8', []), 'INVALID_ASSIGNMENT');
  refusal(() => panel.assign('cand-8', ['eng-3', 'eng-3']), 'INVALID_ASSIGNMENT');
  refusal(() => panel.readCards('eng-3', 'cand-9'), 'UNKNOWN_CANDIDATE');
  refusal(() => panel.openDebrief('cand-9', 'hm-1'), 'UNKNOWN_CANDIDATE');
});

test('other cards read as SEALED until the viewer has submitted', () => {
  const of = rubric();
  const panel = loop();
  panel.submit(card(of, 'eng-4'));

  const sealed = panel.readCards('eng-3', 'cand-7');
  assert.deepEqual(sealed, [
    { status: 'PENDING', interviewerId: 'eng-3' },
    { status: 'SEALED', interviewerId: 'eng-4' },
    { status: 'SEALED', interviewerId: 'eng-5' },
  ]);
  assert.deepEqual(Object.keys(sealed[1]!), ['status', 'interviewerId']);
  assert.ok(Object.isFrozen(sealed));
  assert.ok(Object.isFrozen(sealed[1]!));

  panel.submit(card(of, 'eng-3'));
  const open = panel.readCards('eng-3', 'cand-7');
  assert.deepEqual(statuses(open), ['SUBMITTED', 'SUBMITTED', 'PENDING']);
  const other = open[1]!;
  if (other.status === 'SUBMITTED') {
    assert.equal(other.card.interviewerId, 'eng-4');
    assert.equal(other.card.ratings['systems-design'], 'sd-strong');
    assert.equal(other.card.evidence.length, 1);
  } else {
    assert.fail('a viewer who is in should read the other card in full');
  }
});

test('a hiring manager gets no bypass', () => {
  const of = rubric();
  const panel = loop();
  panel.submit(card(of, 'eng-4'));
  assert.deepEqual(statuses(panel.readCards({ id: 'hm-1', role: 'hiring-manager' }, 'cand-7')), [
    'SEALED',
    'SEALED',
    'SEALED',
  ]);
  assert.deepEqual(statuses(panel.readCards({ id: 'eng-3', role: 'hiring-manager' }, 'cand-7')), [
    'PENDING',
    'SEALED',
    'SEALED',
  ]);
  refusal(() => panel.readCards({ id: ' ' }, 'cand-7'), 'INVALID_VIEWER');
});

test('a recusal is final and reads with its reason once the viewer is in', () => {
  const of = rubric();
  const panel = loop();
  panel.recuse('eng-5', 'cand-7', REASON);
  refusal(() => panel.submit(card(of, 'eng-5')), 'RECUSED');
  refusal(() => panel.recuse('eng-5', 'cand-7', 'changed my mind'), 'RECUSED');

  const views = panel.readCards('eng-5', 'cand-7');
  assert.deepEqual(statuses(views), ['PENDING', 'PENDING', 'RECUSED']);
  const own = views[2]!;
  if (own.status === 'RECUSED') {
    assert.equal(own.reason, REASON);
  } else {
    assert.fail('the recusing viewer should read as RECUSED');
  }
});

test('submit refuses a repeat, a stranger, a second rubric and an incomplete card', () => {
  const of = rubric();
  const panel = loop();
  const partial = setRating(
    draftScorecard(of, { loopId: 'loop-14', candidateRef: 'cand-7', interviewerId: 'eng-3' }),
    'systems-design',
    'sd-working',
  );
  refusal(() => panel.submit(partial), 'MISSING_RATING');
  panel.submit(card(of, 'eng-3'));
  refusal(() => panel.submit(card(of, 'eng-3')), 'ALREADY_SUBMITTED');
  refusal(() => panel.recuse('eng-3', 'cand-7', 'second thoughts'), 'ALREADY_SUBMITTED');
  refusal(() => panel.submit(card(of, 'eng-9')), 'NOT_ASSIGNED');
  refusal(() => panel.recuse('eng-9', 'cand-7', REASON), 'NOT_ASSIGNED');
  refusal(() => panel.recuse('eng-4', 'cand-7', '   '), 'INVALID_RECUSAL');
  refusal(() => panel.submit(card(of, 'eng-4', 'loop-15')), 'WRONG_LOOP');
  refusal(
    () => panel.submit(card(reviseRubric(of, { role: 'Backend Engineer II' }), 'eng-4')),
    'RUBRIC_MISMATCH',
  );
});

test('openDebrief waits for the whole panel and then reveals every card', () => {
  const of = rubric();
  const panel = loop();
  panel.submit(card(of, 'eng-3'));
  panel.recuse('eng-5', 'cand-7', REASON);
  assert.throws(
    () => panel.openDebrief('cand-7', { id: 'hm-1', role: 'hiring-manager' }),
    (error: unknown) =>
      error instanceof SealedLoopError &&
      error.code === 'NOT_ALL_IN' &&
      error.message.includes('eng-4'),
  );
  assert.deepEqual(statuses(panel.readCards('eng-4', 'cand-7')), ['SEALED', 'PENDING', 'SEALED']);

  panel.submit(card(of, 'eng-4'));
  const debrief = panel.openDebrief('cand-7', { id: 'hm-1', role: 'hiring-manager' });
  assert.equal(debrief.openedBy, 'hm-1');
  assert.equal(debrief.rubricHash, of.rubricHash);
  assert.deepEqual(
    debrief.cards.map((filed) => filed.interviewerId),
    ['eng-3', 'eng-4'],
  );
  assert.deepEqual(
    debrief.recusals.map((filed) => filed.interviewerId),
    ['eng-5'],
  );
  assert.ok(Object.isFrozen(debrief));
  assert.ok(Object.isFrozen(debrief.cards));
});

test('a panel that all recused opens with no cards and no rubric hash', () => {
  const panel = loop();
  for (const interviewerId of ['eng-3', 'eng-4', 'eng-5']) {
    panel.recuse(interviewerId, 'cand-7', REASON);
  }
  const debrief = panel.openDebrief('cand-7', 'hm-1');
  assert.deepEqual(debrief.cards, []);
  assert.equal(debrief.rubricHash, null);
  assert.equal(debrief.recusals.length, 3);
});

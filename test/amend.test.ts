import assert from 'node:assert/strict';
import { test } from 'node:test';

import { verifyChain } from '../src/chain.ts';
import { SealedLoopError } from '../src/errors.ts';
import { Loop } from '../src/loop.ts';
import { NOT_ASSESSED } from '../src/rating.ts';
import { createRubric } from '../src/rubric.ts';
import type { Rubric } from '../src/rubric.ts';
import { addEvidence, draftScorecard, setRating } from '../src/scorecard.ts';
import type { Scorecard } from '../src/scorecard.ts';
import { MemoryStore } from '../src/store.ts';
import { digestOf } from '../src/vault.ts';

const NOTE = 'Designed for failure, load and rollback on the whiteboard.';
const FIRST_REASON = 'Re-read the transcript: the load ceiling was named, not guessed.';
const SECOND_REASON = 'The rollback plan came from the interviewer before me.';

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

function card(of: Rubric, interviewerId: string): Scorecard {
  const drafted = draftScorecard(of, {
    loopId: 'loop-14',
    candidateRef: 'cand-7',
    interviewerId,
  });
  const rated = setRating(
    setRating(drafted, 'systems-design', 'sd-strong'),
    'collaboration',
    NOT_ASSESSED,
  );
  return addEvidence(rated, 'systems-design', NOTE);
}

function submitted(): { panel: Loop; cardId: string } {
  const of = rubric();
  const panel = new Loop({ loopId: 'loop-14', store: new MemoryStore() });
  panel.assign('cand-7', ['eng-3', 'eng-4']);
  const filed = panel.submit(card(of, 'eng-3'));
  panel.submit(card(of, 'eng-4'));
  return { panel, cardId: filed.cardId };
}

function revealed(): { panel: Loop; cardId: string } {
  const loop = submitted();
  loop.panel.openDebrief('cand-7', 'hm-1');
  return loop;
}

function refusal(block: () => unknown, code: string): void {
  assert.throws(block, (error: unknown) => error instanceof SealedLoopError && error.code === code);
}

test('the first reveal freezes every card of that candidate', () => {
  const of = rubric();
  const panel = new Loop({ loopId: 'loop-14', store: new MemoryStore() });
  panel.assign('cand-7', ['eng-3', 'eng-4']);
  panel.submit(card(of, 'eng-3'));
  panel.submit(card(of, 'eng-4'));

  const debrief = panel.openDebrief('cand-7', 'hm-1');
  const first = debrief.cards[0]!;
  assert.match(String(first.revealedAt), /^\d{4}-/);
  assert.equal(debrief.cards[1]!.revealedAt, first.revealedAt);

  refusal(() => setRating(first, 'systems-design', 'sd-working'), 'FROZEN_AFTER_REVEAL');
  refusal(() => addEvidence(first, 'collaboration', NOTE), 'FROZEN_AFTER_REVEAL');
  refusal(() => panel.submit(card(of, 'eng-3')), 'FROZEN_AFTER_REVEAL');

  const second = panel.openDebrief('cand-7', 'hm-2');
  assert.equal(second.cards[0]!.revealedAt, first.revealedAt);
});

test('the original rating stays readable after two amendments', () => {
  const { panel, cardId } = revealed();
  const first = panel.amend(cardId, 'systems-design', 'sd-working', {
    by: 'eng-3',
    reason: FIRST_REASON,
  });
  const second = panel.amend(cardId, 'systems-design', 'sd-novice', {
    by: 'eng-3',
    reason: SECOND_REASON,
  });

  assert.equal(first.afterReveal, true);
  assert.equal(first.cardId, cardId);
  assert.equal(first.interviewerId, 'eng-3');
  assert.equal(first.by, 'eng-3');
  assert.equal(first.level, 'sd-working');
  assert.equal(first.reasonDigest, digestOf(FIRST_REASON));
  assert.ok(Object.isFrozen(second));
  assert.ok(second.seq > first.seq);

  const view = panel.readCards('eng-3', 'cand-7')[0]!;
  if (view.status === 'SUBMITTED') {
    assert.equal(view.card.ratings['systems-design'], 'sd-strong');
  } else {
    assert.fail('the author should read their own filed card');
  }

  const current = panel.currentRatings(cardId);
  assert.equal(current['systems-design'], 'sd-novice');
  assert.equal(current['collaboration'], NOT_ASSESSED);
  assert.ok(Object.isFrozen(current));

  const trace = panel.amendmentsAfterReveal('cand-7');
  assert.deepEqual(
    trace.map((amendment) => amendment.level),
    ['sd-working', 'sd-novice'],
  );
  const read = panel.readText('cand-7', first.reasonDigest);
  assert.equal(read.status, 'PRESENT');
  if (read.status === 'PRESENT') {
    assert.equal(read.text, FIRST_REASON);
  }
});

test('another interviewer cannot amend a card they did not write', () => {
  const { panel, cardId } = revealed();
  assert.throws(
    () =>
      panel.amend(cardId, 'systems-design', 'sd-novice', { by: 'eng-4', reason: FIRST_REASON }),
    (error: unknown) =>
      error instanceof SealedLoopError &&
      error.code === 'NOT_AUTHOR' &&
      error.message.includes('eng-4'),
  );
  refusal(
    () => panel.amend(cardId, 'systems-design', 'sd-novice', { by: 'hm-1', reason: FIRST_REASON }),
    'NOT_AUTHOR',
  );
  assert.deepEqual(panel.amendmentsAfterReveal('cand-7'), []);
  assert.equal(panel.currentRatings(cardId)['systems-design'], 'sd-strong');
});

test('an amendment needs a card, a reveal, a reason and an anchor', () => {
  const { panel, cardId } = submitted();
  const request = { by: 'eng-3', reason: FIRST_REASON };
  refusal(() => panel.amend(cardId, 'systems-design', 'sd-working', request), 'NOT_REVEALED');
  refusal(() => panel.amend('nowhere', 'systems-design', 'sd-working', request), 'UNKNOWN_CARD');

  panel.openDebrief('cand-7', 'hm-1');
  refusal(
    () => panel.amend(cardId, 'systems-design', 'sd-working', { by: ' ', reason: FIRST_REASON }),
    'INVALID_AMENDMENT',
  );
  refusal(
    () => panel.amend(cardId, 'systems-design', 'sd-working', { by: 'eng-3', reason: '   ' }),
    'INVALID_AMENDMENT',
  );
  refusal(() => panel.amend(cardId, 'systems-design', 'co-working', request), 'OFF_SCALE');
  refusal(() => panel.amend(cardId, 'vibes', 'sd-working', request), 'UNKNOWN_COMPETENCY');
  refusal(() => panel.amendmentsAfterReveal('cand-9'), 'UNKNOWN_CANDIDATE');
  assert.deepEqual(panel.amendmentsAfterReveal('cand-7'), []);
});

test('an amendment appends a chain entry that carries a digest, not the reason', () => {
  const { panel, cardId } = revealed();
  panel.amend(cardId, 'systems-design', 'sd-working', { by: 'eng-3', reason: FIRST_REASON });

  const chain = panel.chain('cand-7');
  assert.deepEqual(
    chain.map((entry) => entry.kind),
    ['assign', 'commit', 'commit', 'amend'],
  );
  const entry = chain[3]!;
  assert.deepEqual(Object.keys(entry.body).sort(), [
    'afterReveal',
    'by',
    'candidateRef',
    'cardId',
    'competencyId',
    'interviewerId',
    'level',
    'reasonDigest',
  ]);
  assert.equal(entry.body['afterReveal'], true);
  assert.equal(entry.body['reasonDigest'], digestOf(FIRST_REASON));
  assert.ok(!JSON.stringify(chain).includes(FIRST_REASON));
  assert.deepEqual(verifyChain(chain), { ok: true });

  const again = panel.openDebrief('cand-7', 'hm-1');
  assert.equal(again.chain.length, 4);
  assert.equal(again.cards[0]!.ratings['systems-design'], 'sd-strong');
});

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
const OTHER_NOTE = 'Walked the rollback plan for the payment path.';
const REASON = 'I managed this candidate for two years.';
const NAME = 'Ada Lovelace';
const BY = 'dpo-1';
const REQUEST = { by: BY, reason: 'The candidate asked for erasure.' };
const AT = '2026-11-03T10:00:00.000Z';

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

function card(of: Rubric, interviewerId: string, note = NOTE): Scorecard {
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
  return addEvidence(rated, 'systems-design', note);
}

function filled(): Loop {
  const of = rubric();
  const panel = new Loop({ loopId: 'loop-14', store: new MemoryStore() });
  panel.assign('cand-7', ['eng-3', 'eng-4'], { displayName: NAME });
  panel.submit(card(of, 'eng-3'));
  panel.recuse('eng-4', 'cand-7', REASON);
  return panel;
}

function refusal(block: () => unknown, code: string): void {
  assert.throws(block, (error: unknown) => error instanceof SealedLoopError && error.code === code);
}

test('cards, recusals and the chain keep digests while the vault keeps the text', () => {
  const panel = filled();
  const debrief = panel.openDebrief('cand-7', 'hm-1');
  const note = debrief.cards[0]!.evidence[0]!;
  assert.deepEqual(Object.keys(note).sort(), ['competencyId', 'digest']);
  assert.equal(note.digest, digestOf(NOTE));
  assert.deepEqual(debrief.cards[0]!.texts, {});
  assert.equal(debrief.recusals[0]!.reasonDigest, digestOf(REASON));
  const written = JSON.stringify(debrief);
  assert.ok(!written.includes(NOTE));
  assert.ok(!written.includes(REASON));
  assert.ok(!written.includes(NAME));

  const read = panel.readText('cand-7', note.digest);
  assert.equal(read.status, 'PRESENT');
  if (read.status === 'PRESENT') {
    assert.equal(read.text, NOTE);
  }
  assert.equal(panel.readDisplayName('cand-7')?.status, 'PRESENT');
});

test('the chain and the commitments still hold after erasure', () => {
  const panel = filled();
  const before = panel.openDebrief('cand-7', 'hm-1');
  const erasure = panel.eraseCandidate('cand-7', { ...REQUEST, at: AT });
  const expected = [digestOf(NAME), digestOf(NOTE), digestOf(REASON)].sort();
  assert.deepEqual([...erasure.digests], expected);
  assert.equal(erasure.erasedAt, AT);

  const after = panel.openDebrief('cand-7', 'hm-1');
  assert.deepEqual(verifyChain(after.chain), { ok: true });
  assert.equal(after.chain.length, before.chain.length + 1);
  const last = after.chain[after.chain.length - 1]!;
  assert.equal(last.kind, 'erasure');
  assert.deepEqual(Object.keys(last.body).sort(), [
    'by',
    'candidateRef',
    'digests',
    'erasedAt',
    'reasonDigest',
  ]);
  assert.deepEqual(last.body['digests'], expected);
  assert.deepEqual(after.cards[0]!.evidence, before.cards[0]!.evidence);
  assert.equal(after.rubricHash, before.rubricHash);
});

test('an erased note is reported as erased, not as present or missing', () => {
  const panel = filled();
  panel.eraseCandidate('cand-7', { ...REQUEST, at: AT });
  panel.eraseCandidate('cand-7', { ...REQUEST, at: '2026-12-01T00:00:00.000Z' });

  const read = panel.readText('cand-7', digestOf(NOTE));
  assert.equal(read.status, 'ERASED');
  assert.ok(!('text' in read));
  if (read.status === 'ERASED') {
    assert.equal(read.by, BY);
    assert.equal(read.erasedAt, AT);
  }
  assert.equal(panel.readText('cand-7', digestOf('never filed')).status, 'MISSING');
  assert.equal(panel.readDisplayName('cand-7')?.status, 'ERASED');

  const own = panel.readCards('eng-4', 'cand-7')[1]!;
  if (own.status === 'RECUSED') {
    assert.equal(own.reason.status, 'ERASED');
  } else {
    assert.fail('the recusing viewer should read as RECUSED');
  }
  refusal(() => panel.readText('cand-7', ' '), 'INVALID_DIGEST');
});

test('erased text backs nothing and refiling it does not resurrect it', () => {
  const of = rubric();
  const panel = new Loop({ loopId: 'loop-14', store: new MemoryStore() });
  panel.assign('cand-7', ['eng-3', 'eng-4']);
  panel.submit(card(of, 'eng-3'));
  panel.eraseCandidate('cand-7', REQUEST);

  refusal(() => panel.submit(card(of, 'eng-4')), 'EVIDENCE_REQUIRED');
  assert.equal(panel.readText('cand-7', digestOf(NOTE)).status, 'ERASED');

  const fresh = panel.submit(card(of, 'eng-4', OTHER_NOTE));
  assert.equal(panel.readText('cand-7', fresh.evidence[0]!.digest).status, 'PRESENT');
  assert.deepEqual(verifyChain(panel.chain('cand-7')), { ok: true });
});

test('retention lists what is due and erases nothing by itself', () => {
  const panel = filled();
  const retention = panel.setRetention('cand-7', '2027-01-31T00:00:00.000Z');
  assert.equal(retention.until, '2027-01-31T00:00:00.000Z');
  assert.deepEqual(panel.dueForErasure('2027-01-30T23:59:59.000Z'), []);
  assert.deepEqual(panel.dueForErasure('2027-02-01T00:00:00.000Z'), [retention]);
  assert.equal(panel.readText('cand-7', digestOf(NOTE)).status, 'PRESENT');

  panel.eraseCandidate('cand-7', REQUEST);
  assert.deepEqual(panel.dueForErasure('2027-02-01T00:00:00.000Z'), []);

  refusal(() => panel.setRetention('cand-7', 'whenever'), 'INVALID_RETENTION');
  refusal(() => panel.eraseCandidate('cand-7', { by: ' ', reason: REASON }), 'INVALID_ERASURE');
  refusal(() => panel.eraseCandidate('cand-9', REQUEST), 'UNKNOWN_CANDIDATE');
});

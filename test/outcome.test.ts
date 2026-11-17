import assert from 'node:assert/strict';
import { test } from 'node:test';

import { verifyChain } from '../src/chain.ts';
import { SealedLoopError } from '../src/errors.ts';
import { Loop } from '../src/loop.ts';
import { MIN_RATINGS_PER_MUST_HAVE, evaluateRule } from '../src/outcome.ts';
import type { GateTrace, RuleOutcome } from '../src/outcome.ts';
import { NOT_ASSESSED } from '../src/rating.ts';
import type { Rating } from '../src/rating.ts';
import { createRubric } from '../src/rubric.ts';
import type { Rubric } from '../src/rubric.ts';
import { addEvidence, draftScorecard, setRating } from '../src/scorecard.ts';
import type { Scorecard } from '../src/scorecard.ts';
import { MemoryStore } from '../src/store.ts';
import type { Resolution } from '../src/store.ts';

const LOOP = 'loop-14';
const CAND = 'cand-7';
const NOTE = 'Designed for failure, load and rollback on the whiteboard.';
const AMEND_REASON = 'Re-read the transcript: the failing case was never run.';
const ARB_REASON = 'The panel split; the follow-up on the retry path settled it.';

type Ratings = Readonly<Record<string, Rating>>;
type Filing = readonly [string, Ratings];

const TOP: Ratings = {
  'systems-design': 'sd-strong',
  testing: 'te-strong',
  collaboration: 'co-working',
};

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
        id: 'testing',
        mustHave: true,
        bar: 2,
        anchors: [
          { id: 'te-novice', level: 1, label: 'Novice', description: 'Tests the happy path.' },
          { id: 'te-working', level: 2, label: 'Working', description: 'Names a failing case.' },
          { id: 'te-strong', level: 3, label: 'Strong', description: 'Tests the boundaries.' },
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

function card(of: Rubric, interviewerId: string, ratings: Ratings): Scorecard {
  let built = draftScorecard(of, { loopId: LOOP, candidateRef: CAND, interviewerId });
  for (const [competencyId, rating] of Object.entries(ratings)) {
    built = setRating(built, competencyId, rating);
    if (rating !== NOT_ASSESSED) {
      built = addEvidence(built, competencyId, NOTE);
    }
  }
  return built;
}

function panelOf(filings: readonly Filing[]): Loop {
  const of = rubric();
  const loop = new Loop({ loopId: LOOP, store: new MemoryStore() });
  loop.assign(
    CAND,
    filings.map(([interviewerId]) => interviewerId),
  );
  for (const [interviewerId, ratings] of filings) {
    loop.submit(card(of, interviewerId, ratings));
  }
  return loop;
}

function opened(filings: readonly Filing[]): Loop {
  const loop = panelOf(filings);
  loop.openDebrief(CAND, 'hm-1');
  return loop;
}

function gateOf(outcome: RuleOutcome, competencyId: string): GateTrace {
  const gate = outcome.trace.gates.find((filed) => filed.competencyId === competencyId);
  if (gate === undefined) {
    throw new Error(`${competencyId} is not a gate of this rubric`);
  }
  return gate;
}

function refusal(block: () => unknown, code: string): void {
  assert.throws(block, (error: unknown) => error instanceof SealedLoopError && error.code === code);
}

test('a top anchor elsewhere never offsets a failed must-have', () => {
  const failed: Ratings = { ...TOP, testing: 'te-novice' };
  const outcome = evaluateRule(
    opened([
      ['eng-3', failed],
      ['eng-4', failed],
    ]),
    CAND,
  );

  assert.equal(outcome.status, 'below-rule');
  assert.equal(outcome.candidateRef, CAND);
  assert.equal(outcome.trace.rule, 'non-compensatory-gates');
  assert.match(String(outcome.trace.rubricHash), /^[0-9a-f]{64}$/);
  assert.deepEqual([...outcome.trace.submittedBy], ['eng-3', 'eng-4']);

  const design = gateOf(outcome, 'systems-design');
  assert.equal(design.status, 'meets-bar');
  assert.equal(design.lowerMedian, 3);
  assert.deepEqual([...design.counted], [3, 3]);
  assert.equal(design.reason, null);
  assert.equal(design.spread, 0);
  assert.equal(design.split, false);
  assert.equal(design.arbitration, null);

  const testing = gateOf(outcome, 'testing');
  assert.equal(testing.status, 'below-bar');
  assert.equal(testing.lowerMedian, 1);
  assert.equal(testing.bar, 2);
  assert.equal(testing.reason, null);
  assert.deepEqual(
    testing.ratings.map((filed) => [filed.interviewerId, filed.rating, filed.level, filed.amended]),
    [
      ['eng-3', 'te-novice', 1, false],
      ['eng-4', 'te-novice', 1, false],
    ],
  );

  assert.deepEqual(
    outcome.trace.gates.map((gate) => gate.competencyId),
    ['systems-design', 'testing'],
  );
  assert.deepEqual(
    outcome.trace.observed.map((trace) => trace.competencyId),
    ['collaboration'],
  );
  assert.ok(!JSON.stringify(outcome).includes('hire'));
  assert.ok(Object.isFrozen(outcome));
  assert.ok(Object.isFrozen(outcome.trace.gates));
});

test('a single-interviewer loop is blocked rather than decided', () => {
  const outcome = evaluateRule(opened([['eng-3', TOP]]), CAND);

  assert.equal(outcome.status, 'blocked');
  assert.equal(MIN_RATINGS_PER_MUST_HAVE, 2);
  assert.equal(outcome.trace.minRatings, MIN_RATINGS_PER_MUST_HAVE);
  for (const gate of outcome.trace.gates) {
    assert.equal(gate.status, 'blocked');
    assert.equal(gate.reason, 'PANEL_TOO_SMALL');
    assert.equal(gate.counted.length, 1);
    assert.deepEqual([...gate.notAssessedBy], []);
  }
  assert.equal(gateOf(outcome, 'systems-design').lowerMedian, 3);
});

test('an unassessed must-have blocks and the rest of the panel still counts', () => {
  const blind: Ratings = { ...TOP, testing: NOT_ASSESSED };
  const outcome = evaluateRule(
    opened([
      ['eng-3', TOP],
      ['eng-4', blind],
      ['eng-5', blind],
    ]),
    CAND,
  );

  assert.equal(outcome.status, 'blocked');
  const testing = gateOf(outcome, 'testing');
  assert.equal(testing.status, 'blocked');
  assert.equal(testing.reason, 'UNASSESSED_MUST_HAVE');
  assert.deepEqual([...testing.counted], [3]);
  assert.deepEqual([...testing.notAssessedBy], ['eng-4', 'eng-5']);
  assert.equal(testing.ratings[1]?.level, null);
  assert.equal(testing.ratings[1]?.rating, NOT_ASSESSED);
  assert.equal(gateOf(outcome, 'systems-design').status, 'meets-bar');

  const enough = evaluateRule(
    opened([
      ['eng-3', TOP],
      ['eng-4', { ...TOP, testing: 'te-working' }],
      ['eng-5', blind],
    ]),
    CAND,
  );
  assert.equal(enough.status, 'meets-rule');
  const rest = gateOf(enough, 'testing');
  assert.equal(rest.status, 'meets-bar');
  assert.deepEqual([...rest.counted], [2, 3]);
  assert.equal(rest.lowerMedian, 2);
  assert.deepEqual([...rest.notAssessedBy], ['eng-5']);
});

test('the lower median reads a panel that agrees on the side of the bar', () => {
  const outcome = evaluateRule(
    opened([
      ['eng-3', { ...TOP, 'systems-design': 'sd-working' }],
      ['eng-4', TOP],
      ['eng-5', TOP],
    ]),
    CAND,
  );
  assert.equal(outcome.status, 'meets-rule');
  const design = gateOf(outcome, 'systems-design');
  assert.deepEqual([...design.counted], [2, 3, 3]);
  assert.equal(design.spread, 1);
  assert.equal(design.split, false);
  assert.equal(design.lowerMedian, 3);
});

test('a must-have the panel split on waits for an arbiter and is then decided', () => {
  const loop = opened([
    ['eng-3', { ...TOP, 'systems-design': 'sd-novice' }],
    ['eng-4', TOP],
  ]);

  const held = evaluateRule(loop, CAND);
  assert.equal(held.status, 'blocked');
  const waiting = gateOf(held, 'systems-design');
  assert.equal(waiting.status, 'blocked');
  assert.equal(waiting.reason, 'ARBITRATION_REQUIRED');
  assert.equal(waiting.spread, 2);
  assert.equal(waiting.split, true);
  assert.equal(waiting.lowerMedian, 1);
  assert.equal(waiting.arbitration, null);
  assert.equal(gateOf(held, 'testing').status, 'meets-bar');

  const arbitration = loop.arbitrate(CAND, 'systems-design', {
    by: 'hm-1',
    resolution: 'below-bar',
    reason: ARB_REASON,
  });
  assert.equal(arbitration.seq, loop.chain(CAND).length - 1);
  assert.deepEqual(verifyChain(loop.chain(CAND)), { ok: true });
  assert.equal(loop.readText(CAND, arbitration.reasonDigest).status, 'PRESENT');
  assert.deepEqual([...loop.arbitrations(CAND)], [arbitration]);

  const decided = evaluateRule(loop, CAND);
  assert.equal(decided.status, 'below-rule');
  const settled = gateOf(decided, 'systems-design');
  assert.equal(settled.status, 'below-bar');
  assert.equal(settled.reason, null);
  assert.equal(settled.arbitration?.by, 'hm-1');
  assert.equal(settled.arbitration?.resolution, 'below-bar');
  assert.equal(settled.arbitration?.seq, arbitration.seq);
  assert.deepEqual([...settled.counted], [1, 3]);
  assert.equal(settled.lowerMedian, 1);
  assert.equal(loop.revealedCards(CAND)[0]!.ratings['systems-design'], 'sd-novice');
});

test('an interviewer who scored the competency is refused as arbiter', () => {
  const of = rubric();
  const loop = new Loop({ loopId: LOOP, store: new MemoryStore() });
  loop.assign(CAND, ['eng-3', 'eng-4', 'eng-5']);
  loop.submit(card(of, 'eng-3', { ...TOP, 'systems-design': 'sd-novice' }));
  loop.submit(card(of, 'eng-4', TOP));
  loop.recuse('eng-5', CAND, 'I referred this candidate.');

  refusal(
    () =>
      loop.arbitrate(CAND, 'systems-design', {
        by: 'hm-1',
        resolution: 'meets-bar',
        reason: ARB_REASON,
      }),
    'NOT_REVEALED',
  );
  loop.openDebrief(CAND, 'hm-1');

  for (const by of ['eng-3', 'eng-4', 'eng-5']) {
    refusal(
      () =>
        loop.arbitrate(CAND, 'systems-design', { by, resolution: 'meets-bar', reason: ARB_REASON }),
      'ARBITER_INVOLVED',
    );
  }
  refusal(
    () => loop.arbitrate(CAND, 'vibes', { by: 'hm-1', resolution: 'meets-bar', reason: ARB_REASON }),
    'UNKNOWN_COMPETENCY',
  );
  refusal(
    () =>
      loop.arbitrate(CAND, 'systems-design', { by: 'hm-1', resolution: 'meets-bar', reason: '  ' }),
    'INVALID_ARBITRATION',
  );
  refusal(
    () =>
      loop.arbitrate(CAND, 'systems-design', {
        by: 'hm-1',
        resolution: 'split-the-difference' as unknown as Resolution,
        reason: ARB_REASON,
      }),
    'INVALID_ARBITRATION',
  );
  refusal(
    () =>
      loop.arbitrate('cand-9', 'systems-design', {
        by: 'hm-1',
        resolution: 'meets-bar',
        reason: ARB_REASON,
      }),
    'UNKNOWN_CANDIDATE',
  );

  loop.arbitrate(CAND, 'systems-design', {
    by: 'hm-1',
    resolution: 'meets-bar',
    reason: ARB_REASON,
  });
  assert.equal(evaluateRule(loop, CAND).status, 'meets-rule');
});

test('the agenda puts the widest gap first and breaks ties by competency id', () => {
  const loop = panelOf([
    ['eng-3', { 'systems-design': 'sd-novice', testing: 'te-working', collaboration: 'co-novice' }],
    ['eng-4', { 'systems-design': 'sd-strong', testing: 'te-strong', collaboration: 'co-working' }],
  ]);
  refusal(() => loop.debriefAgenda(CAND), 'NOT_REVEALED');

  loop.openDebrief(CAND, 'hm-1');
  const agenda = loop.debriefAgenda(CAND);
  assert.deepEqual(
    agenda.map((item) => [item.competencyId, item.spread, item.needsArbitration]),
    [
      ['systems-design', 2, true],
      ['collaboration', 1, false],
      ['testing', 1, false],
    ],
  );
  assert.deepEqual([...agenda[0]!.counted], [1, 3]);
  assert.equal(agenda[1]!.mustHave, false);
  assert.equal(agenda[1]!.split, true);
  assert.ok(Object.isFrozen(agenda));
  assert.ok(Object.isFrozen(agenda[0]!));
});

test('an amendment is the level the rule reads', () => {
  const loop = opened([
    ['eng-3', TOP],
    ['eng-4', TOP],
  ]);
  assert.equal(evaluateRule(loop, CAND).status, 'meets-rule');

  const cardId = loop.revealedCards(CAND)[0]!.cardId;
  loop.amend(cardId, 'testing', 'te-novice', { by: 'eng-3', reason: AMEND_REASON });

  const outcome = evaluateRule(loop, CAND);
  assert.equal(outcome.status, 'blocked');
  const testing = gateOf(outcome, 'testing');
  assert.equal(testing.reason, 'ARBITRATION_REQUIRED');
  assert.deepEqual([...testing.counted], [1, 3]);
  assert.equal(testing.lowerMedian, 1);
  assert.deepEqual(
    testing.ratings.map((filed) => filed.amended),
    [true, false],
  );
  assert.equal(loop.revealedCards(CAND)[0]!.ratings['testing'], 'te-strong');

  loop.arbitrate(CAND, 'testing', { by: 'hm-1', resolution: 'below-bar', reason: ARB_REASON });
  assert.equal(evaluateRule(loop, CAND).status, 'below-rule');
});

test('a rule outcome needs the reveal and a panel', () => {
  const loop = panelOf([
    ['eng-3', TOP],
    ['eng-4', TOP],
  ]);
  refusal(() => evaluateRule(loop, CAND), 'NOT_REVEALED');
  refusal(() => evaluateRule(loop, 'cand-9'), 'UNKNOWN_CANDIDATE');

  loop.openDebrief(CAND, 'hm-1');
  assert.equal(evaluateRule(loop, CAND).status, 'meets-rule');
});

test('a panel that all recused is blocked and nothing is scored', () => {
  const loop = new Loop({ loopId: LOOP, store: new MemoryStore() });
  loop.assign(CAND, ['eng-3', 'eng-4']);
  loop.recuse('eng-3', CAND, 'I managed this candidate for two years.');
  loop.recuse('eng-4', CAND, 'I referred this candidate.');
  loop.openDebrief(CAND, 'hm-1');

  const outcome = evaluateRule(loop, CAND);
  assert.equal(outcome.status, 'blocked');
  assert.equal(outcome.trace.rubricHash, null);
  assert.deepEqual([...outcome.trace.gates], []);
  assert.deepEqual([...outcome.trace.observed], []);
  assert.deepEqual([...outcome.trace.submittedBy], []);
  assert.deepEqual([...loop.debriefAgenda(CAND)], []);
});

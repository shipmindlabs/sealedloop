import assert from 'node:assert/strict';
import { test } from 'node:test';

import { commitmentOf, nextEntry, verifyChain } from '../src/chain.ts';
import type { ChainEntry } from '../src/chain.ts';
import { SealedLoopError } from '../src/errors.ts';
import { Loop } from '../src/loop.ts';
import { NOT_ASSESSED } from '../src/rating.ts';
import { createRubric } from '../src/rubric.ts';
import type { Rubric } from '../src/rubric.ts';
import { addEvidence, draftScorecard, setRating } from '../src/scorecard.ts';
import type { Scorecard } from '../src/scorecard.ts';
import { MemoryStore } from '../src/store.ts';

const NOTE = 'Designed for failure, load and rollback on the whiteboard.';
const REASON = 'I managed this candidate for two years.';
const SALT = new Uint8Array(32).fill(7);
const OTHER_SALT = new Uint8Array(32).fill(8);

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

function entries(): ChainEntry[] {
  const chain: ChainEntry[] = [];
  for (const interviewerId of ['eng-3', 'eng-4', 'eng-5']) {
    chain.push(nextEntry(chain, 'commit', { interviewerId, commitment: 'a'.repeat(64) }));
  }
  return chain;
}

class EditedStore extends MemoryStore {
  readonly cardEdits = new Map<string, Scorecard>();
  readonly droppedSeqs = new Set<number>();

  override readCards(candidateRef: string): readonly Scorecard[] {
    return super
      .readCards(candidateRef)
      .map((filed) => this.cardEdits.get(filed.interviewerId) ?? filed);
  }

  override readChain(candidateRef: string): readonly ChainEntry[] {
    return super.readChain(candidateRef).filter((entry) => !this.droppedSeqs.has(entry.seq));
  }
}

function filled(): { panel: Loop; store: EditedStore } {
  const of = rubric();
  const store = new EditedStore();
  const panel = new Loop({ loopId: 'loop-14', store });
  panel.assign('cand-7', ['eng-3', 'eng-4']);
  panel.submit(card(of, 'eng-3'));
  panel.submit(card(of, 'eng-4'));
  return { panel, store };
}

function tampered(block: () => unknown, named: string): void {
  assert.throws(
    block,
    (error: unknown) =>
      error instanceof SealedLoopError && error.code === 'TAMPERED' && error.message.includes(named),
  );
}

test('entries link by hash and an intact chain verifies', () => {
  const chain = entries();
  assert.deepEqual(
    chain.map((entry) => entry.seq),
    [0, 1, 2],
  );
  assert.equal(chain[0]!.prev, null);
  assert.equal(chain[1]!.prev, chain[0]!.hash);
  assert.equal(chain[2]!.prev, chain[1]!.hash);
  assert.match(chain[0]!.hash, /^[0-9a-f]{64}$/);
  assert.ok(Object.isFrozen(chain[0]!));
  assert.deepEqual(verifyChain(chain), { ok: true });
  assert.deepEqual(verifyChain([]), { ok: true });
});

test('a deleted middle entry is named by its own seq', () => {
  const chain = entries();
  assert.deepEqual(verifyChain([chain[0]!, chain[2]!]), { ok: false, firstBroken: 1 });
  assert.deepEqual(verifyChain([chain[1]!, chain[2]!]), { ok: false, firstBroken: 0 });
  assert.deepEqual(verifyChain([chain[0]!, chain[2]!, chain[1]!]), { ok: false, firstBroken: 1 });
});

test('an edited body no longer matches the entry hash', () => {
  const chain = entries();
  const edited: ChainEntry = {
    ...chain[1]!,
    body: { interviewerId: 'eng-4', commitment: 'b'.repeat(64) },
  };
  assert.deepEqual(verifyChain([chain[0]!, edited, chain[2]!]), { ok: false, firstBroken: 1 });
});

test('a body with no canonical form reads as broken rather than throwing', () => {
  const chain = entries();
  const broken: ChainEntry = { ...chain[0]!, body: { at: new Date(0) } };
  assert.deepEqual(verifyChain([broken]), { ok: false, firstBroken: 0 });
});

test('a commitment covers the salt, the ratings and the evidence digest', () => {
  const of = rubric();
  const base = card(of, 'eng-3');
  const commitment = commitmentOf(base, SALT);
  assert.match(commitment, /^[0-9a-f]{64}$/);
  assert.equal(commitmentOf(card(of, 'eng-3'), SALT), commitment);
  assert.notEqual(commitmentOf(base, OTHER_SALT), commitment);
  assert.notEqual(commitmentOf(setRating(base, 'systems-design', 'sd-working'), SALT), commitment);
  assert.notEqual(
    commitmentOf(addEvidence(base, 'collaboration', 'Wrote the disagreement down.'), SALT),
    commitment,
  );
  assert.notEqual(commitmentOf(card(of, 'eng-4'), SALT), commitment);
  assert.notEqual(
    commitmentOf(addEvidence(base, 'systems-design', 'Walked the rollback plan.'), SALT),
    commitmentOf(addEvidence(base, 'systems-design', 'Walked the rollout plan..'), SALT),
  );
});

test('submit appends a commit entry that carries no card text', () => {
  const of = rubric();
  const panel = new Loop({ loopId: 'loop-14', store: new MemoryStore() });
  panel.assign('cand-7', ['eng-3', 'eng-4', 'eng-5']);
  panel.submit(card(of, 'eng-3'));
  panel.submit(card(of, 'eng-4'));
  panel.recuse('eng-5', 'cand-7', REASON);
  const chain = panel.chain('cand-7');
  assert.deepEqual(
    chain.map((entry) => entry.kind),
    ['assign', 'commit', 'commit', 'recuse'],
  );
  assert.deepEqual(verifyChain(chain), { ok: true });
  const first = chain[1]!;
  const second = chain[2]!;
  assert.deepEqual(Object.keys(first.body).sort(), [
    'candidateRef',
    'commitment',
    'interviewerId',
  ]);
  assert.match(String(first.body['commitment']), /^[0-9a-f]{64}$/);
  assert.notEqual(first.body['commitment'], second.body['commitment']);
  const written = JSON.stringify(chain);
  assert.ok(!written.includes(NOTE));
  assert.ok(!written.includes('sd-strong'));
  assert.ok(!written.includes(REASON));
  const debrief = panel.openDebrief('cand-7', 'hm-1');
  assert.equal(debrief.chain.length, 4);
  assert.ok(Object.isFrozen(debrief.chain));
});

test('a rating edited straight in the store is caught at the reveal', () => {
  const { panel, store } = filled();
  panel.openDebrief('cand-7', 'hm-1');
  const filed = store.readCards('cand-7')[1]!;
  store.cardEdits.set('eng-4', {
    ...filed,
    ratings: { ...filed.ratings, 'systems-design': 'sd-novice' },
  });
  tampered(() => panel.openDebrief('cand-7', 'hm-1'), 'entry 2');
  tampered(() => panel.openDebrief('cand-7', 'hm-1'), 'eng-4');
});

test('evidence added behind the API is caught at the reveal', () => {
  const { panel, store } = filled();
  const filed = store.readCards('cand-7')[0]!;
  store.cardEdits.set('eng-3', {
    ...filed,
    evidence: [...filed.evidence, { competencyId: 'collaboration', text: 'Added afterwards.' }],
  });
  tampered(() => panel.openDebrief('cand-7', 'hm-1'), 'entry 1');
});

test('a dropped chain entry is named when the debrief opens', () => {
  const { panel, store } = filled();
  store.droppedSeqs.add(1);
  tampered(() => panel.openDebrief('cand-7', 'hm-1'), 'breaks at entry 1');
});

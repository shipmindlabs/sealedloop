import assert from 'node:assert/strict';
import { test } from 'node:test';

import { SealedLoopError } from '../src/errors.ts';
import {
  DEFAULT_MIN_EVIDENCE_CHARS,
  assertSameRubric,
  createRubric,
  reviseRubric,
} from '../src/rubric.ts';
import type { RubricInput } from '../src/rubric.ts';

function input(): RubricInput {
  return {
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
  };
}

function refusal(block: () => unknown, code: string): void {
  assert.throws(block, (error: unknown) => error instanceof SealedLoopError && error.code === code);
}

test('a created rubric carries a sha256 hex hash and no parent', () => {
  const rubric = createRubric(input());
  assert.match(rubric.rubricHash, /^[0-9a-f]{64}$/);
  assert.equal(rubric.parent, null);
  assert.equal(rubric.competencies.length, 2);
  assert.equal(rubric.minEvidenceChars, 20);
});

test('minEvidenceChars falls back to the default and takes part in the hash', () => {
  const base = input();
  const plain = createRubric({ role: base.role, competencies: base.competencies });
  assert.equal(plain.minEvidenceChars, DEFAULT_MIN_EVIDENCE_CHARS);
  assert.notEqual(plain.rubricHash, createRubric(base).rubricHash);
});

test('a created rubric is frozen all the way down', () => {
  const rubric = createRubric(input());
  assert.ok(Object.isFrozen(rubric));
  assert.ok(Object.isFrozen(rubric.competencies));
  assert.ok(Object.isFrozen(rubric.competencies[0]!.anchors[0]!));
  assert.throws(() => {
    (rubric.competencies[0]! as { bar: number }).bar = 1;
  }, TypeError);
});

test('declaration order of the input does not change the hash', () => {
  const base = input();
  const reordered: RubricInput = {
    competencies: base.competencies.map((competency) => ({
      bar: competency.bar,
      anchors: competency.anchors.map((anchor) => ({
        description: anchor.description,
        label: anchor.label,
        level: anchor.level,
        id: anchor.id,
      })),
      mustHave: competency.mustHave,
      id: competency.id,
    })),
    minEvidenceChars: base.minEvidenceChars,
    role: base.role,
  };
  assert.equal(createRubric(reordered).rubricHash, createRubric(base).rubricHash);
});

test('composed and decomposed text hash the same', () => {
  const composed = input();
  const decomposed = input();
  const composedFirst = { ...composed.competencies[0]!, id: 'caf\u00e9-ops' };
  const decomposedFirst = { ...decomposed.competencies[0]!, id: 'cafe\u0301-ops' };
  assert.equal(
    createRubric({ ...composed, competencies: [composedFirst] }).rubricHash,
    createRubric({ ...decomposed, competencies: [decomposedFirst] }).rubricHash,
  );
});

test('changing an anchor description changes the hash', () => {
  const base = input();
  const first = base.competencies[0]!;
  const edited = {
    ...first,
    anchors: [
      { ...first.anchors[0]!, description: 'Sketches one service and asks for the next step.' },
      first.anchors[1]!,
      first.anchors[2]!,
    ],
  };
  assert.notEqual(
    createRubric({ ...base, competencies: [edited, base.competencies[1]!] }).rubricHash,
    createRubric(base).rubricHash,
  );
});

test('a lone surrogate in a rubric is refused', () => {
  const base = input();
  const first = base.competencies[0]!;
  const broken = {
    ...first,
    anchors: [{ ...first.anchors[0]!, label: 'Novice\ud83d' }, first.anchors[1]!, first.anchors[2]!],
  };
  refusal(
    () => createRubric({ ...base, competencies: [broken] }),
    'CANONICAL_LONE_SURROGATE',
  );
});

test('reviseRubric links to the old hash and leaves the old rubric alone', () => {
  const rubric = createRubric(input());
  const before = rubric.rubricHash;
  const revised = reviseRubric(rubric, { role: 'Backend Engineer II' });
  assert.equal(revised.parent, before);
  assert.notEqual(revised.rubricHash, before);
  assert.equal(revised.minEvidenceChars, rubric.minEvidenceChars);
  assert.equal(rubric.rubricHash, before);
  assert.equal(rubric.parent, null);
  assert.equal(rubric.role, 'Backend Engineer');
  const third = reviseRubric(revised);
  assert.equal(third.parent, revised.rubricHash);
});

test('an invalid rubric is refused rather than frozen', () => {
  const base = input();
  const first = base.competencies[0]!;
  refusal(() => createRubric({ ...base, role: '  ' }), 'INVALID_RUBRIC');
  refusal(() => createRubric({ ...base, competencies: [] }), 'INVALID_RUBRIC');
  refusal(() => createRubric({ ...base, minEvidenceChars: 0 }), 'INVALID_RUBRIC');
  refusal(() => createRubric({ ...base, minEvidenceChars: 1.5 }), 'INVALID_RUBRIC');
  refusal(
    () => createRubric({ ...base, competencies: [{ ...first, bar: 9 }] }),
    'INVALID_RUBRIC',
  );
  refusal(
    () =>
      createRubric({
        ...base,
        competencies: [{ ...first, anchors: [first.anchors[1]!, first.anchors[0]!] }],
      }),
    'INVALID_RUBRIC',
  );
  refusal(
    () => createRubric({ ...base, competencies: [first, { ...first, id: 'systems-design' }] }),
    'INVALID_RUBRIC',
  );
});

test('anchor ids must be unique and may not take the not-assessed name', () => {
  const base = input();
  const first = base.competencies[0]!;
  refusal(
    () =>
      createRubric({
        ...base,
        competencies: [
          { ...first, anchors: [first.anchors[0]!, { ...first.anchors[1]!, id: 'sd-novice' }] },
        ],
      }),
    'INVALID_RUBRIC',
  );
  refusal(
    () =>
      createRubric({
        ...base,
        competencies: [
          { ...first, bar: 1, anchors: [{ ...first.anchors[0]!, id: 'not-assessed' }] },
        ],
      }),
    'INVALID_RUBRIC',
  );
});

test('scorecards across two rubric hashes are refused', () => {
  const rubric = createRubric(input());
  const revised = reviseRubric(rubric, { role: 'Backend Engineer II' });
  assert.equal(
    assertSameRubric([{ rubricHash: rubric.rubricHash }, { rubricHash: rubric.rubricHash }]),
    rubric.rubricHash,
  );
  assert.throws(
    () => assertSameRubric([{ rubricHash: rubric.rubricHash }, { rubricHash: revised.rubricHash }]),
    (error: unknown) =>
      error instanceof SealedLoopError &&
      error.code === 'RUBRIC_MISMATCH' &&
      error.message.includes(rubric.rubricHash) &&
      error.message.includes(revised.rubricHash),
  );
  refusal(() => assertSameRubric([]), 'EMPTY_CARD_SET');
  refusal(() => assertSameRubric([{ rubricHash: '' }]), 'MISSING_RUBRIC_HASH');
});

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { canonicalize } from '../src/canonical.ts';
import { SealedLoopError } from '../src/errors.ts';

function refusal(block: () => unknown, code: string): void {
  assert.throws(block, (error: unknown) => error instanceof SealedLoopError && error.code === code);
}

test('key order does not change the canonical form', () => {
  assert.equal(canonicalize({ b: 1, a: 2 }), '{"a":2,"b":1}');
  assert.equal(canonicalize({ b: 1, a: 2 }), canonicalize({ a: 2, b: 1 }));
});

test('keys sort by UTF-16 code unit, not by locale', () => {
  assert.equal(
    canonicalize({ '\u00e4': 1, A: 2, a: 3, '\u20ac': 4 }),
    '{"A":2,"a":3,"\u00e4":1,"\u20ac":4}',
  );
});

test('a surrogate pair key sorts before a high BMP key', () => {
  const form = canonicalize({ '\uffff': 1, '\u{1f600}': 2 });
  assert.ok(form.indexOf('\u{1f600}') < form.indexOf('\uffff'));
});

test('composed and decomposed text reach the same form', () => {
  assert.equal(canonicalize({ note: 'caf\u00e9' }), canonicalize({ note: 'cafe\u0301' }));
  assert.equal(canonicalize({ '\u00e9': 1 }), canonicalize({ 'e\u0301': 1 }));
});

test('numbers use the ECMAScript form', () => {
  assert.equal(canonicalize([1, 1.5, 1e21, -0, 1e-7]), '[1,1.5,1e+21,0,1e-7]');
});

test('keys that collide after normalization are refused', () => {
  refusal(() => canonicalize({ '\u00e9': 1, 'e\u0301': 2 }), 'CANONICAL_DUPLICATE_KEY');
});

test('values with no canonical form are refused', () => {
  refusal(() => canonicalize({ score: Number.NaN }), 'CANONICAL_NON_FINITE_NUMBER');
  refusal(() => canonicalize({ score: Number.POSITIVE_INFINITY }), 'CANONICAL_NON_FINITE_NUMBER');
  refusal(() => canonicalize({ score: undefined }), 'CANONICAL_UNDEFINED');
  refusal(() => canonicalize([undefined]), 'CANONICAL_UNDEFINED');
  refusal(() => canonicalize({ at: new Date(0) }), 'CANONICAL_NON_PLAIN_OBJECT');
  refusal(() => canonicalize({ seen: new Map() }), 'CANONICAL_NON_PLAIN_OBJECT');
  refusal(() => canonicalize({ size: 1n }), 'CANONICAL_UNSUPPORTED_TYPE');
});

test('lone surrogates are refused in values and in keys', () => {
  refusal(() => canonicalize({ label: 'a\ud83d' }), 'CANONICAL_LONE_SURROGATE');
  refusal(() => canonicalize({ label: '\ude00b' }), 'CANONICAL_LONE_SURROGATE');
  refusal(() => canonicalize({ '\ud83d': 1 }), 'CANONICAL_LONE_SURROGATE');
  assert.equal(canonicalize(['\u{1f600}']), '["\u{1f600}"]');
});

test('a cycle is refused instead of overflowing the stack', () => {
  const loop: Record<string, unknown> = {};
  loop.self = loop;
  refusal(() => canonicalize(loop), 'CANONICAL_CYCLE');
});

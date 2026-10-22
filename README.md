# sealedloop

An interview-loop engine: a frozen rubric, sealed independent scorecards, ratings only on
anchored levels backed by evidence, and a declared aggregation rule — so a hiring decision
can be traced back to what each interviewer actually observed.

Two invariants are in place so far: **a rubric is identified by the hash of its own
content, and scorecards that rest on two different rubrics are refused instead of
averaged**; and **a rating is an anchor of that competency or the explicit value
`NOT_ASSESSED` — never a bare number, never silence.**

## Requirements

Node 22.18 or newer. The package ships TypeScript sources and no dependencies; Node strips
the type annotations at load time.

## Use

```ts
import { assertSameRubric, createRubric, reviseRubric } from 'sealedloop';

const rubric = createRubric({
  role: 'Backend Engineer',
  minEvidenceChars: 40,
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
  ],
});

rubric.rubricHash; // sha256 hex of the canonical form
Object.isFrozen(rubric); // true, all the way down

const revised = reviseRubric(rubric, { role: 'Backend Engineer II' });
revised.parent === rubric.rubricHash; // the old hash, kept as lineage

assertSameRubric([{ rubricHash: rubric.rubricHash }, { rubricHash: revised.rubricHash }]);
// throws SealedLoopError with code RUBRIC_MISMATCH, naming both hashes
```

### Scorecards

```ts
import { addEvidence, checkSubmittable, draftScorecard, NOT_ASSESSED, setRating } from 'sealedloop';

let card = draftScorecard(rubric, {
  loopId: 'loop-14',
  candidateRef: 'cand-7',
  interviewerId: 'eng-3',
});
card.rubricHash === rubric.rubricHash; // the card is stamped with the rubric it was drafted from

card = setRating(card, 'systems-design', 'sd-strong');
card = addEvidence(card, 'systems-design', 'Walked a rollback plan for the payment path.');

checkSubmittable(card); // returns quietly once every competency carries a value
```

Cards are frozen; `setRating` and `addEvidence` return a new card and leave the old one
untouched.

`setRating` takes the id of an anchor of that competency, or `NOT_ASSESSED`. A level number
or an anchor belonging to another competency is refused with `OFF_SCALE`; an unknown
competency with `UNKNOWN_COMPETENCY`.

`checkSubmittable` refuses a card where a competency was never given a value
(`MISSING_RATING` — leaving it out is not the same as saying `NOT_ASSESSED`), and one where
a top or bottom anchor has no evidence note filed under that competency holding at least
`rubric.minEvidenceChars` characters after trimming (`EVIDENCE_REQUIRED`).

`anchorPosition(NOT_ASSESSED)` is `null` rather than a number, so a competency nobody
assessed can never be ranked below the lowest anchor. `anchorPosition(anchorId, competency)`
returns the declared level of that anchor.

## How the hash is formed

`canonicalize` serializes a value per RFC 8785: object keys sorted by UTF-16 code unit,
numbers in ECMAScript form, and every string NFC-normalized first — so `"caf\u00e9"` and
`"cafe\u0301"` reach the same bytes. Values with no canonical form are refused rather than
coerced: `NaN`, `Infinity`, `undefined`, lone surrogates, cycles, and anything that is not
a plain object or array. `rubricHash` is the SHA-256 hex digest of that canonical form,
computed over the role, the parent hash, the evidence minimum and the ordered competencies.

## Errors

Every failure is a `SealedLoopError` carrying a string `code`: `CANONICAL_*` for values with
no canonical form, `INVALID_RUBRIC` for a rubric that cannot be frozen as given,
`RUBRIC_MISMATCH`, `EMPTY_CARD_SET` and `MISSING_RUBRIC_HASH` for scorecard sets, and
`INVALID_SCORECARD`, `INVALID_EVIDENCE`, `UNKNOWN_COMPETENCY`, `OFF_SCALE`,
`MISSING_RATING` and `EVIDENCE_REQUIRED` for a single card.

## Tests

```sh
npm test
```

## Limits

- Sealing, cross-card aggregation and the declared decision rule are still to come. A card
  that passes `checkSubmittable` is complete, not submitted.
- A hash is an identity, not a signature. It proves two parties scored the same rubric
  text; it does not prove who wrote it or when, and anyone can recompute it.
- Canonicalization covers the JSON data model only — no dates, maps, sets, class
  instances, `bigint` or symbols. Pass those as strings or numbers.
- NFC normalization makes visually identical text hash alike; it does not defend against
  look-alike characters from different scripts.
- `reviseRubric` records a single `parent` hash. Lineage is a chain, not a merge graph, and
  nothing here stores past revisions for you.
- Anchor levels must be integers in strictly ascending order and the bar must be one of
  them. Half-levels and per-interviewer bars are out of scope.
- `minEvidenceChars` counts Unicode code points after trimming. It measures effort, not
  substance: a long note that says nothing still passes.
- Evidence is required at the ends of the scale only, where a rating is hardest to revisit.
  Middle anchors are taken as given.
- No persistence, no transport, no identity model.

Built and maintained by Shipmind Labs — https://shipmindlabs.com

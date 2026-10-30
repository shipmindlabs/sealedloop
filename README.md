# sealedloop

An interview-loop engine: a frozen rubric, sealed independent scorecards, ratings only on
anchored levels backed by evidence, and a declared aggregation rule — so a hiring decision
can be traced back to what each interviewer actually observed.

Four invariants are in place so far: **a rubric is identified by the hash of its own
content, and scorecards that rest on two different rubrics are refused instead of
averaged**; **a rating is an anchor of that competency or the explicit value
`NOT_ASSESSED` — never a bare number, never silence**; **another interviewer's card
reads as `SEALED` until you have submitted or recused, and no role buys a look**; and
**every submission is committed to an append-only hash chain, so a card edited behind the
API's back is named when the debrief opens.**

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

### The loop

```ts
import { Loop, MemoryStore } from 'sealedloop';

const loop = new Loop({ loopId: 'loop-14', store: new MemoryStore() });
loop.assign('cand-7', ['eng-3', 'eng-4', 'eng-5']);

loop.submit(card); // the card above, from eng-3; checkSubmittable runs again here

loop.readCards('eng-4', 'cand-7');
// [ { status: 'SEALED', interviewerId: 'eng-3' },
//   { status: 'PENDING', interviewerId: 'eng-4' },
//   { status: 'SEALED', interviewerId: 'eng-5' } ]

loop.recuse('eng-5', 'cand-7', 'I managed this candidate for two years.');
loop.readCards('eng-5', 'cand-7');
// eng-3 now reads as { status: 'SUBMITTED', interviewerId: 'eng-3', card }
// and eng-4 as { status: 'PENDING', interviewerId: 'eng-4' }

loop.openDebrief('cand-7', { id: 'hm-1', role: 'hiring-manager' });
// throws NOT_ALL_IN while eng-4 has neither submitted nor recused
```

`readCards(viewer, candidateRef)` returns one view per assigned interviewer, in panel order.
Until the viewer has submitted or recused for that candidate, every other interviewer reads
as `{ status: 'SEALED', interviewerId }` and nothing else — no ratings, no evidence, not even
whether a card exists. The viewer's own entry is never sealed: it is `PENDING`, `SUBMITTED`
with the card in full, or `RECUSED` with the reason.

A viewer is an id or `{ id, role }`. The role is accepted and then carries no weight:
`{ id: 'hm-1', role: 'hiring-manager' }` reads what any other outsider reads. What unseals a
panel is having filed, not a title.

`recuse` is final. A later `submit` for that candidate throws `RECUSED`, a second recusal
throws it too, and recusing after submitting throws `ALREADY_SUBMITTED`. `submit` also
refuses a card stamped with another `loopId` (`WRONG_LOOP`), a second card from the same
interviewer (`ALREADY_SUBMITTED`), anyone off the panel (`NOT_ASSIGNED`) and a card resting
on a second rubric (`RUBRIC_MISMATCH`).

`openDebrief(candidateRef, by)` throws `NOT_ALL_IN` while any assigned interviewer has
neither submitted nor recused, naming who is missing. Once the panel is complete it returns
every card, every recusal, the chain, and the one `rubricHash` they share — `null` if
everybody recused.

`Store` is the whole persistence seam: assignments, cards, recusals, chain entries and the
salt kept beside each sealed card. `MemoryStore` keeps a loop in process, and
`new Loop({ loopId })` makes one for you.

### The commitment chain

Each candidate has an append-only chain of entries `{ seq, prev, kind, body, hash }`, where
`prev` is the hash of the entry before it and `hash` is the SHA-256 of the canonical form of
`{ seq, prev, kind, body }`. `assign` writes one entry, `submit` writes a `commit` entry and
`recuse` writes a `recuse` entry holding a digest of the reason rather than its text.

```ts
import { verifyChain } from 'sealedloop';

loop.chain('cand-7');
// [ { seq: 0, prev: null, kind: 'assign', body: { candidateRef, interviewerIds }, hash },
//   { seq: 1, prev: '…', kind: 'commit', body: { candidateRef, interviewerId, commitment }, hash } ]

verifyChain(loop.chain('cand-7')); // { ok: true }
```

The commitment is `SHA-256(salt + canonical skeleton)`. The skeleton holds the ids, the
`rubricHash`, the rated anchor of every competency with its level, and the SHA-256 digest of
each evidence note — never the note text. The 32-byte random salt is kept beside the sealed
card in the `Store` and never enters the chain, so a chain entry neither reads back as a
scorecard nor confirms a guessed one.

`openDebrief` runs `verifyChain` and then recomputes every commitment from the stored card
and its salt. A card that no longer matches throws `TAMPERED` naming the interviewer and the
`seq` of the commitment it broke; a chain whose links no longer hold throws `TAMPERED` naming
the first broken `seq`.

`verifyChain(entries)` returns `{ ok: true }` or `{ ok: false, firstBroken }`, where
`firstBroken` is the first `seq` at which the chain stops holding — so a deleted middle entry
is named by its own `seq`, and an edited one by its.

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
`RUBRIC_MISMATCH`, `EMPTY_CARD_SET` and `MISSING_RUBRIC_HASH` for scorecard sets,
`INVALID_SCORECARD`, `INVALID_EVIDENCE`, `UNKNOWN_COMPETENCY`, `OFF_SCALE`,
`MISSING_RATING` and `EVIDENCE_REQUIRED` for a single card, and `INVALID_LOOP`,
`INVALID_ASSIGNMENT`, `ALREADY_ASSIGNED`, `UNKNOWN_CANDIDATE`, `NOT_ASSIGNED`, `WRONG_LOOP`,
`ALREADY_SUBMITTED`, `RECUSED`, `INVALID_RECUSAL`, `INVALID_VIEWER`, `NOT_ALL_IN` and
`TAMPERED` for the loop.

## Tests

```sh
npm test
```

## Limits

- Anyone who reads the storage directly bypasses sealing. Sealing is a rule of this API, not
  encryption: a `Store` holds plain cards, so a database client, a backup or a debug log sees
  all of them.
- The chain catches an edited card, not a rewritten store. Whoever can change cards, salts
  and entries together can recompute a consistent history; what the chain takes away is the
  quiet single-row edit. Copy the head hash somewhere that writer does not control if you
  need more than that.
- Cross-card aggregation and the declared decision rule are still to come. A debrief hands
  you every card; it does not score them.
- A panel is assigned once per candidate. `assign` on a candidate who already has one throws
  `ALREADY_ASSIGNED`; adding or dropping an interviewer mid-loop is out of scope.
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
- `MemoryStore` keeps everything in one process and nothing survives a restart. There is no
  transport and no identity model: the loop trusts the ids it is handed.

Built and maintained by Shipmind Labs — https://shipmindlabs.com

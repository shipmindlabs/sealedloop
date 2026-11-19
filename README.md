# sealedloop

An interview-loop engine: a frozen rubric, sealed independent scorecards, ratings only on
anchored levels backed by evidence, and a declared aggregation rule — so a hiring decision
can be traced back to what each interviewer actually observed.

Eight invariants are in place so far: **a rubric is identified by the hash of its own
content, and scorecards that rest on two different rubrics are refused instead of
averaged**; **a rating is an anchor of that competency or the explicit value
`NOT_ASSESSED` — never a bare number, never silence**; **another interviewer's card
reads as `SEALED` until you have submitted or recused, and no role buys a look**; **every
submission is committed to an append-only hash chain, so a card edited behind the API's
back is named when the debrief opens**; **the free text sits in an erasable
per-candidate vault keyed by digest, so erasing a candidate leaves a tombstone and the
chain still verifies**; **once the debrief has revealed the cards a level stops moving
quietly: an amendment is filed beside the original, with a reason, and the original stays
readable**; **the rule judges each must-have alone, so a top anchor elsewhere never
offsets a failed one, and a must-have carrying fewer than two independent ratings blocks
the rule instead of passing it**; and **a must-have the panel split on is neither averaged
nor rounded: it blocks until somebody who did not rate it records a resolution, and the
debrief opens on the widest gap.**

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

`addEvidence` files the digest of the note under the competency and keeps the text beside it
on the draft, where `readDraftText(card, digest)` reads it back. On `submit` the text moves
into the candidate's vault in the `Store` and the filed card keeps digests only.

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
loop.assign('cand-7', ['eng-3', 'eng-4', 'eng-5'], { displayName: 'Ada Lovelace' });

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
with the card in full, or `RECUSED` with the reason read out of the vault.

A viewer is an id or `{ id, role }`. The role is accepted and then carries no weight:
`{ id: 'hm-1', role: 'hiring-manager' }` reads what any other outsider reads. What unseals a
panel is having filed, not a title.

The optional `displayName` is kept as a digest on the assignment, never as text; it is the
only place a candidate's name enters the loop at all.

`recuse` is final. A later `submit` for that candidate throws `RECUSED`, a second recusal
throws it too, and recusing after submitting throws `ALREADY_SUBMITTED`. `submit` also
refuses a card stamped with another `loopId` (`WRONG_LOOP`), a second card from the same
interviewer (`ALREADY_SUBMITTED`), anyone off the panel (`NOT_ASSIGNED`) and a card resting
on a second rubric (`RUBRIC_MISMATCH`).

`openDebrief(candidateRef, by)` throws `NOT_ALL_IN` while any assigned interviewer has
neither submitted nor recused, naming who is missing. Once the panel is complete it returns
every card, every recusal, the chain, and the one `rubricHash` they share — `null` if
everybody recused.

`Store` is the whole persistence seam: assignments, cards, recusals, chain entries, the salt
kept beside each sealed card, the reveal that froze a candidate, the amendments filed after
it, the arbitrations that settled a split, the per-candidate text vault and the retention
dates. `MemoryStore` keeps a loop in process, and `new Loop({ loopId })` makes one for you.

### After the reveal

```ts
const debrief = loop.openDebrief('cand-7', 'hm-1');
debrief.cards[0].revealedAt; // the instant of the first reveal, as an ISO 8601 string

setRating(debrief.cards[0], 'systems-design', 'sd-working'); // throws FROZEN_AFTER_REVEAL
loop.submit(anotherCard); // for an already revealed candidate: FROZEN_AFTER_REVEAL

const cardId = debrief.cards[0].cardId; // submit returns the filed card, which carries it
const amendment = loop.amend(cardId, 'systems-design', 'sd-working', {
  by: 'eng-3',
  reason: 'Re-read the transcript: the load ceiling was named, not guessed.',
});
amendment.afterReveal; // true
amendment.seq; // the seq of the 'amend' entry in the chain

loop.currentRatings(cardId); // { 'systems-design': 'sd-working', collaboration: 'not-assessed' }
loop.amendmentsAfterReveal('cand-7'); // every amendment, oldest first, for the rule trace
```

The first `openDebrief` is the one that freezes; a later one leaves the instant it stamped in
place. From then on nothing edits a card for that candidate: `setRating` and `addEvidence` on
a revealed card throw `FROZEN_AFTER_REVEAL`, and so does a `submit` for that candidate.

A level still moves, but only in the open. `amend(cardId, competencyId, level, { by, reason })`
belongs to the author of that card alone — anyone else gets `NOT_AUTHOR`, a hiring manager
included — it needs a non-empty reason (`INVALID_AMENDMENT`), it refuses before the reveal
with `NOT_REVEALED`, and it names an unknown card with `UNKNOWN_CARD`. The level goes through
the same check as `setRating`, so `OFF_SCALE` and `UNKNOWN_COMPETENCY` still apply. It appends
an `amend` entry to the chain, keeps the reason in the vault behind its digest, and files the
amendment beside the original with `afterReveal: true`. The card itself is untouched: a card
filed as `sd-strong` still reads `sd-strong` in `readCards` and in a later debrief.

`currentRatings(cardId)` is what a rule reads: the filed ratings with the latest amendment of
each competency laid over them. `amendmentsAfterReveal(candidateRef)` lists every amendment in
the order it was filed, so a decision resting on an amended level can name who moved it, why,
and the `seq` the move sits at in the chain.

### A rule outcome, not a verdict

```ts
import { evaluateRule } from 'sealedloop';

loop.openDebrief('cand-7', 'hm-1');
const outcome = evaluateRule(loop, 'cand-7');

outcome.status; // 'meets-rule', 'below-rule' or 'blocked' — never a hire or a no-hire
outcome.trace.gates;
// [ { competencyId: 'systems-design', bar: 2, lowerMedian: 3, counted: [3, 3], spread: 0,
//     split: false, notAssessedBy: [], status: 'meets-bar', reason: null,
//     arbitration: null, ratings: [ … ] },
//   { competencyId: 'testing', bar: 2, lowerMedian: 1, counted: [1, 1], spread: 0,
//     split: false, notAssessedBy: [], status: 'below-bar', reason: null,
//     arbitration: null, ratings: [ … ] } ]
outcome.trace.observed; // every competency that is not a must-have, traced and gating nothing
```

`evaluateRule(loop, candidateRef)` reads the revealed cards — before the debrief opens it
throws `NOT_REVEALED` — and judges each must-have on its own. Within one competency it drops
every `NOT_ASSESSED` rating, takes the anchor level of the rest, and asks whether the lower
median of those levels reaches that competency's `bar`. Nothing is summed, averaged or
weighted across competencies: a panel that saw a top anchor on everything else still reads
`below-rule` when one must-have sits under its bar.

A must-have carrying fewer than `MIN_RATINGS_PER_MUST_HAVE` (2) independently submitted
ratings is not judged at all. The gate is `blocked` — `UNASSESSED_MUST_HAVE` when somebody
filed `NOT_ASSESSED` there, `PANEL_TOO_SMALL` when the panel was simply too small — and the
outcome is `blocked` with it. Those two are reasons in the trace rather than errors, and
silence never passes: a must-have nobody could speak to blocks the rule instead of clearing
it, which is also why a single-interviewer loop produces no outcome at all.

Each entry in `ratings` names the interviewer, the card, the rating as the rule read it, its
level and whether an amendment moved it — `evaluateRule` reads `currentRatings`, so an amended
level is the one counted and the trace says whose it is.

**Why there is no hiring decision here.** What this engine can hold honestly is a record: who
observed what, against bars that were declared before anyone sat down, with the evidence and
the amendments that produced each level. Who to hire turns on the team, the role, the other
candidates and the risk somebody is willing to carry — none of which a scorecard knows. So the
rule computes the one part that is checkable and hands back the trace that got there. A
`meets-rule` is not an offer and a `below-rule` is not a rejection; both are a reading of the
rubric, and the decision stays with the people who have to live with it.

### Widest gap first, and a split waits for an arbiter

```ts
loop.debriefAgenda('cand-7');
// [ { competencyId: 'systems-design', mustHave: true, spread: 2, split: true,
//     counted: [1, 3], needsArbitration: true },
//   { competencyId: 'collaboration', mustHave: false, spread: 1, split: true,
//     counted: [1, 2], needsArbitration: false },
//   { competencyId: 'testing', mustHave: true, spread: 1, split: false,
//     counted: [2, 3], needsArbitration: false } ]

evaluateRule(loop, 'cand-7').status; // 'blocked' while systems-design waits

const arbitration = loop.arbitrate('cand-7', 'systems-design', {
  by: 'hm-1',
  resolution: 'below-bar',
  reason: 'The panel split; the follow-up on the retry path settled it.',
});
arbitration.seq; // the seq of the 'arbitrate' entry in the chain

evaluateRule(loop, 'cand-7').status; // 'below-rule' — the resolution decided that gate
loop.revealedCards('cand-7')[0].ratings['systems-design']; // 'sd-novice', as it was filed
```

`debriefAgenda(candidateRef)` lists every competency ordered by `spread` — the distance between
the highest and the lowest level the panel counted — widest first, ties broken by competency id,
so the debrief opens on the disagreement instead of on rubric order. It reads the revealed cards,
so before the debrief it throws `NOT_REVEALED`, and `needsArbitration` marks the gates the rule
is waiting on.

A must-have is held when the panel is far apart: `spread >= MIN_ARBITRATION_SPREAD` (2), or
`split` — some counted level under the bar and some at or above it. The gate reads `blocked` with
`ARBITRATION_REQUIRED` and the outcome is `blocked` with it, however the lower median falls. Two
interviewers two anchors apart, or one on each side of the bar, is not a number to take a median
of; it is a question for somebody who was not in either room.

`arbitrate(candidateRef, competencyId, { by, resolution, reason })` records the answer.
`resolution` is `'meets-bar'` or `'below-bar'` and it decides that competency. The arbiter must
be somebody who neither rated that competency for that candidate nor recused from the loop —
either one is `ARBITER_INVOLVED`, and an amended level counts as having rated it. The reason is
required (`INVALID_ARBITRATION`, which also names a resolution that is neither side of the bar),
it refuses before the reveal with `NOT_REVEALED`, and a competency outside the rubric is
`UNKNOWN_COMPETENCY`. It appends an `arbitrate` entry to the chain, keeps the reason in the vault
behind its digest, and files the arbitration where `arbitrations(candidateRef)` and the gate
trace can both name who settled it.

Nothing is rewritten. The cards keep the anchors they were filed with, `counted` still holds both
levels, and the decided gate carries `arbitration: { by, resolution, reasonDigest, seq }` beside
them — so a settled must-have reads as a resolution somebody put their name to, not as a split
that quietly averaged out.

### The commitment chain

Each candidate has an append-only chain of entries `{ seq, prev, kind, body, hash }`, where
`prev` is the hash of the entry before it and `hash` is the SHA-256 of the canonical form of
`{ seq, prev, kind, body }`. `assign` writes one entry, `submit` writes a `commit` entry,
`recuse` writes a `recuse` entry holding a digest of the reason rather than its text, `amend`
writes an `amend` entry, `arbitrate` writes an `arbitrate` entry holding the resolution and the
digest of the reason, and `eraseCandidate` writes an `erasure` entry.

```ts
import { verifyChain } from 'sealedloop';

loop.chain('cand-7');
// [ { seq: 0, prev: null, kind: 'assign', body: { candidateRef, interviewerIds, displayNameDigest }, hash },
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
the first broken `seq`. An amendment leaves both intact: it never rewrites the card the
commitment was taken over.

`verifyChain(entries)` returns `{ ok: true }` or `{ ok: false, firstBroken }`, where
`firstBroken` is the first `seq` at which the chain stops holding — so a deleted middle entry
is named by its own `seq`, and an edited one by its.

### Erasable text and retention

Interview notes, recusal reasons, amendment reasons and the candidate display name never sit
on a card, on a recusal or in a chain entry. Those keep the SHA-256 digest of the
NFC-normalized text; the text itself lives in a per-candidate vault in the `Store`, keyed by
that digest.

```ts
loop.readText('cand-7', digest);
// { status: 'PRESENT', digest, text: 'Walked a rollback plan for the payment path.' }
loop.readDisplayName('cand-7'); // the same shape, or undefined if none was given

const erasure = loop.eraseCandidate('cand-7', {
  by: 'dpo-1',
  reason: 'The candidate asked for erasure.',
});
erasure.digests; // every digest the vault held, all of them kept

loop.readText('cand-7', digest);
// { status: 'ERASED', digest, erasedAt: '2026-11-03T10:00:00.000Z', by: 'dpo-1' }

verifyChain(loop.chain('cand-7')); // still { ok: true }
```

`eraseCandidate(candidateRef, { by, reason, at })` replaces every text in that candidate's
vault with a tombstone `{ erasedAt, by }`, keeps every digest, and appends an `erasure`
entry naming the digests, the eraser, the instant and the digest of the stated reason. It
removes nothing the chain or the commitments rest on, so `verifyChain` and the recomputed
commitments still pass afterwards, and a debrief opened after an erasure carries the same
evidence digests as one opened before it. `at` defaults to now; a second erasure leaves the
first tombstone in place.

A read is one of three answers and never an empty string: `PRESENT` with the text, `ERASED`
with `erasedAt` and `by`, `MISSING` for a digest the vault never held — so an erased note is
reported as erased rather than as absent. Erased text backs nothing: a card whose top or
bottom anchor rests on an erased note is refused with `EVIDENCE_REQUIRED`, and filing the
same text again does not reopen the tombstone.

`setRetention(candidateRef, until)` records a date and `dueForErasure(now)` lists the
candidates past theirs that still hold text, earliest first. Nothing is erased automatically:
the list is for a person or a job to act on.

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
`MISSING_RATING` and `EVIDENCE_REQUIRED` for a single card, `INVALID_LOOP`,
`INVALID_ASSIGNMENT`, `ALREADY_ASSIGNED`, `UNKNOWN_CANDIDATE`, `NOT_ASSIGNED`, `WRONG_LOOP`,
`ALREADY_SUBMITTED`, `RECUSED`, `INVALID_RECUSAL`, `INVALID_VIEWER`, `NOT_ALL_IN` and
`TAMPERED` for the loop, `FROZEN_AFTER_REVEAL`, `NOT_REVEALED`, `UNKNOWN_CARD`,
`NOT_AUTHOR` and `INVALID_AMENDMENT` for a card after the reveal, `ARBITER_INVOLVED` and
`INVALID_ARBITRATION` for an arbitration, and `INVALID_DIGEST`, `INVALID_ERASURE` and
`INVALID_RETENTION` for the vault. A blocked gate is not one of them:
`UNASSESSED_MUST_HAVE`, `PANEL_TOO_SMALL` and `ARBITRATION_REQUIRED` are reasons carried in a
rule trace.

## Tests

```sh
npm test
```

## Limits

- Anyone who reads the storage directly bypasses sealing. Sealing is a rule of this API, not
  encryption: a `Store` holds plain cards and a vault of plain notes, so a database client, a
  backup or a debug log sees all of them.
- The chain catches an edited card, not a rewritten store. Whoever can change cards, salts
  and entries together can recompute a consistent history; what the chain takes away is the
  quiet single-row edit. Copy the head hash somewhere that writer does not control if you
  need more than that.
- Erasure keeps every digest, because the commitments rest on them. A digest does not read
  back as text, but it confirms a guess: anyone holding a copy of a note can check that it
  was the note erased.
- Nothing erases itself and nothing expires. `dueForErasure` lists what is past its date;
  `eraseCandidate` is someone's decision, it takes the whole vault of one candidate rather
  than a single note, and a backup taken before it still holds the text.
- The freeze holds for cards the API hands you. `setRating` refuses a card read after the
  reveal because that card carries `revealedAt`; a draft kept in a variable from before the
  reveal can still be edited in memory, and `submit` is where it is turned away.
- An amendment moves a level, not a note. `amend` takes a rating and a reason, evidence filed
  before the reveal stands as it is, and nothing re-runs `checkSubmittable`, so an amendment
  onto a top or bottom anchor is not asked for a new note.
- A rule outcome is not a decision and nothing enforces it. `evaluateRule` says whether the
  bars the panel declared were reached; it does not rank one candidate against another, and
  nothing here stops a loop that reads `below-rule` or `blocked` from going ahead anyway.
- The median compares levels, not judgement. Two interviewers who read the same anchor
  differently still yield two numbers, and the lower median takes the more cautious of them;
  a gap of two or a split across the bar is handed to an arbiter, but a narrower disagreement
  on one side of the bar is simply counted.
- Arbitration decides a gate, it does not re-score it. The resolution stands beside the levels
  the panel filed, nothing is recounted, and a second arbitration of the same competency is
  the one the rule reads while the first stays in the chain.
- An arbiter is uninvolved by the record, not by a title. Anybody who did not rate that
  competency for that candidate and did not recuse can arbitrate it; the loop trusts the ids it
  is handed and does not know who was in the room.
- Only must-haves wait. A competency that is not a must-have carries its spread on the agenda
  and gates nothing, so a panel split on it is discussed rather than resolved.
- The two-rating floor is one constant for every competency. `MIN_RATINGS_PER_MUST_HAVE` is
  2; per-competency floors, weighted competencies and tie-breaks are out of scope.
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

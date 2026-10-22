import { createHash } from 'node:crypto';

import { canonicalize } from './canonical.ts';
import { SealedLoopError } from './errors.ts';
import { NOT_ASSESSED } from './rating.ts';

export const DEFAULT_MIN_EVIDENCE_CHARS = 80;

export interface AnchorLevel {
  readonly id: string;
  readonly level: number;
  readonly label: string;
  readonly description: string;
}

export interface Competency {
  readonly id: string;
  readonly mustHave: boolean;
  readonly anchors: readonly AnchorLevel[];
  readonly bar: number;
}

export interface Rubric {
  readonly role: string;
  readonly parent: string | null;
  readonly minEvidenceChars: number;
  readonly competencies: readonly Competency[];
  readonly rubricHash: string;
}

export interface AnchorLevelInput {
  readonly id: string;
  readonly level: number;
  readonly label: string;
  readonly description: string;
}

export interface CompetencyInput {
  readonly id: string;
  readonly mustHave: boolean;
  readonly anchors: readonly AnchorLevelInput[];
  readonly bar: number;
}

export interface RubricInput {
  readonly role: string;
  readonly competencies: readonly CompetencyInput[];
  readonly minEvidenceChars?: number;
  readonly parent?: string | null;
}

export interface RubricRevision {
  readonly role?: string;
  readonly competencies?: readonly CompetencyInput[];
  readonly minEvidenceChars?: number;
}

export interface RubricBound {
  readonly rubricHash: string;
}

export function createRubric(input: RubricInput): Rubric {
  return build(
    input.role,
    input.competencies,
    input.minEvidenceChars ?? DEFAULT_MIN_EVIDENCE_CHARS,
    input.parent ?? null,
  );
}

export function reviseRubric(rubric: Rubric, changes: RubricRevision = {}): Rubric {
  return build(
    changes.role ?? rubric.role,
    changes.competencies ?? rubric.competencies,
    changes.minEvidenceChars ?? rubric.minEvidenceChars,
    rubric.rubricHash,
  );
}

export function assertSameRubric(cards: readonly RubricBound[]): string {
  if (cards.length === 0) {
    throw new SealedLoopError('EMPTY_CARD_SET', 'at least one scorecard is required');
  }
  let agreed = '';
  for (let index = 0; index < cards.length; index += 1) {
    const card = cards[index] as RubricBound | undefined;
    const hash = card?.rubricHash;
    if (typeof hash !== 'string' || hash === '') {
      throw new SealedLoopError(
        'MISSING_RUBRIC_HASH',
        `cards[${index}] carries no rubricHash`,
      );
    }
    if (agreed === '') {
      agreed = hash;
    } else if (agreed !== hash) {
      throw new SealedLoopError(
        'RUBRIC_MISMATCH',
        `scorecards rest on two rubrics: ${agreed} and ${hash}`,
      );
    }
  }
  return agreed;
}

function build(
  role: unknown,
  competencies: unknown,
  minEvidenceChars: unknown,
  parent: string | null,
): Rubric {
  const body = {
    role: requireText(role, 'role'),
    parent: parent === null ? null : requireText(parent, 'parent'),
    minEvidenceChars: requireCount(minEvidenceChars, 'minEvidenceChars'),
    competencies: buildCompetencies(competencies),
  };
  const rubricHash = createHash('sha256').update(canonicalize(body), 'utf8').digest('hex');
  return deepFreeze({ ...body, rubricHash });
}

function buildCompetencies(value: unknown): Competency[] {
  const list = requireList(value, 'competencies');
  const competencies: Competency[] = [];
  const seen = new Set<string>();
  for (let index = 0; index < list.length; index += 1) {
    const where = `competencies[${index}]`;
    const raw = requireRecord(list[index], where);
    const id = requireText(raw.id, `${where}.id`);
    if (seen.has(id)) {
      throw new SealedLoopError(
        'INVALID_RUBRIC',
        `${where}.id repeats an earlier competency: ${id}`,
      );
    }
    seen.add(id);
    if (typeof raw.mustHave !== 'boolean') {
      throw new SealedLoopError('INVALID_RUBRIC', `${where}.mustHave must be a boolean`);
    }
    const anchors = buildAnchors(raw.anchors, where);
    const bar = raw.bar;
    if (typeof bar !== 'number' || !anchors.some((anchor) => anchor.level === bar)) {
      throw new SealedLoopError('INVALID_RUBRIC', `${where}.bar must name one of the anchor levels`);
    }
    competencies.push({ id, mustHave: raw.mustHave, anchors, bar });
  }
  return competencies;
}

function buildAnchors(value: unknown, where: string): AnchorLevel[] {
  const list = requireList(value, `${where}.anchors`);
  const anchors: AnchorLevel[] = [];
  const seen = new Set<string>();
  let previous: number | null = null;
  for (let index = 0; index < list.length; index += 1) {
    const at = `${where}.anchors[${index}]`;
    const raw = requireRecord(list[index], at);
    const id = requireText(raw.id, `${at}.id`);
    if (id === NOT_ASSESSED) {
      throw new SealedLoopError(
        'INVALID_RUBRIC',
        `${at}.id may not be ${NOT_ASSESSED}, which marks a competency left unrated`,
      );
    }
    if (seen.has(id)) {
      throw new SealedLoopError('INVALID_RUBRIC', `${at}.id repeats an earlier anchor: ${id}`);
    }
    seen.add(id);
    const level = raw.level;
    if (typeof level !== 'number' || !Number.isInteger(level)) {
      throw new SealedLoopError('INVALID_RUBRIC', `${at}.level must be an integer`);
    }
    if (previous !== null && level <= previous) {
      throw new SealedLoopError(
        'INVALID_RUBRIC',
        `${at}.level must be greater than the level before it`,
      );
    }
    previous = level;
    anchors.push({
      id,
      level,
      label: requireText(raw.label, `${at}.label`),
      description: requireText(raw.description, `${at}.description`),
    });
  }
  return anchors;
}

function requireText(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new SealedLoopError('INVALID_RUBRIC', `${field} must be a non-empty string`);
  }
  return value.normalize('NFC');
}

function requireCount(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1) {
    throw new SealedLoopError('INVALID_RUBRIC', `${field} must be a positive integer`);
  }
  return value;
}

function requireList(value: unknown, field: string): readonly unknown[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new SealedLoopError('INVALID_RUBRIC', `${field} must be a non-empty array`);
  }
  return value as readonly unknown[];
}

function requireRecord(value: unknown, field: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new SealedLoopError('INVALID_RUBRIC', `${field} must be an object`);
  }
  return value as Record<string, unknown>;
}

function deepFreeze<T>(value: T): T {
  if (typeof value === 'object' && value !== null) {
    for (const inner of Object.values(value as object)) {
      deepFreeze(inner);
    }
    Object.freeze(value);
  }
  return value;
}

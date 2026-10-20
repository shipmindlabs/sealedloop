import { SealedLoopError } from './errors.ts';

export function canonicalize(value: unknown): string {
  return serialize(value, '$', new Set<object>());
}

function serialize(value: unknown, path: string, ancestors: Set<object>): string {
  if (value === null) {
    return 'null';
  }
  switch (typeof value) {
    case 'boolean':
      return value ? 'true' : 'false';
    case 'number':
      if (!Number.isFinite(value)) {
        throw new SealedLoopError(
          'CANONICAL_NON_FINITE_NUMBER',
          `${String(value)} at ${path} has no canonical form`,
        );
      }
      return String(value);
    case 'string':
      return JSON.stringify(normalizeText(value, path));
    case 'undefined':
      throw new SealedLoopError('CANONICAL_UNDEFINED', `undefined at ${path} has no canonical form`);
    case 'object':
      return serializeObject(value as object, path, ancestors);
    default:
      throw new SealedLoopError(
        'CANONICAL_UNSUPPORTED_TYPE',
        `${typeof value} at ${path} has no canonical form`,
      );
  }
}

function serializeObject(value: object, path: string, ancestors: Set<object>): string {
  if (ancestors.has(value)) {
    throw new SealedLoopError('CANONICAL_CYCLE', `${path} refers back to a value containing it`);
  }
  ancestors.add(value);
  try {
    return Array.isArray(value)
      ? serializeArray(value as readonly unknown[], path, ancestors)
      : serializeRecord(value, path, ancestors);
  } finally {
    ancestors.delete(value);
  }
}

function serializeArray(value: readonly unknown[], path: string, ancestors: Set<object>): string {
  const items: string[] = [];
  for (let index = 0; index < value.length; index += 1) {
    items.push(serialize(value[index], `${path}[${index}]`, ancestors));
  }
  return `[${items.join(',')}]`;
}

function serializeRecord(value: object, path: string, ancestors: Set<object>): string {
  const prototype = Object.getPrototypeOf(value) as unknown;
  if (prototype !== Object.prototype && prototype !== null) {
    throw new SealedLoopError(
      'CANONICAL_NON_PLAIN_OBJECT',
      `${path} is not a plain object or array`,
    );
  }
  const record = value as Record<string, unknown>;
  const members: Array<[string, string]> = [];
  const seen = new Set<string>();
  for (const key of Object.keys(record)) {
    const name = normalizeText(key, `${path} key ${JSON.stringify(key)}`);
    if (seen.has(name)) {
      throw new SealedLoopError(
        'CANONICAL_DUPLICATE_KEY',
        `${path} has two keys that normalize to ${JSON.stringify(name)}`,
      );
    }
    seen.add(name);
    members.push([name, serialize(record[key], `${path}.${name}`, ancestors)]);
  }
  members.sort((left, right) => compareCodeUnits(left[0], right[0]));
  return `{${members.map(([name, member]) => `${JSON.stringify(name)}:${member}`).join(',')}}`;
}

function compareCodeUnits(left: string, right: string): number {
  if (left < right) {
    return -1;
  }
  return left > right ? 1 : 0;
}

function normalizeText(text: string, path: string): string {
  for (let index = 0; index < text.length; index += 1) {
    const unit = text.charCodeAt(index);
    if (unit >= 0xdc00 && unit <= 0xdfff) {
      throw loneSurrogate(path, index);
    }
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = text.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) {
        throw loneSurrogate(path, index);
      }
      index += 1;
    }
  }
  return text.normalize('NFC');
}

function loneSurrogate(path: string, index: number): SealedLoopError {
  return new SealedLoopError(
    'CANONICAL_LONE_SURROGATE',
    `${path} holds a lone surrogate at code unit ${index}`,
  );
}

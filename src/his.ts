// Shape exported by the official ALTCHA 3.5.0 collector. These are client-provided
// observations, not a cryptographic signature or an automation probability.
export interface HisData {
  focus: [number, number, number, number][];
  maxTouchPoints: number;
  pointer: [number, number, number][];
  scroll: [number, number][];
  time: number;
  touch: [number, number, number, number, number, number][];
}

export class HisError extends Error {
  constructor(readonly code: 'HIS_MISSING' | 'HIS_INVALID') {
    super(code === 'HIS_MISSING' ? 'Отсутствует снимок HIS' : 'Некорректный формат или размер HIS');
  }
}

function object(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function integer(value: unknown, min = 0, max = Number.MAX_SAFE_INTEGER): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < min || value > max) {
    throw new HisError('HIS_INVALID');
  }
  return value;
}

function coordinate(value: unknown): number { return integer(value, -10_000_000, 10_000_000); }

function fraction(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 1) {
    throw new HisError('HIS_INVALID');
  }
  return value;
}

function samples<T>(value: unknown, width: number, parse: (sample: unknown[]) => T): T[] {
  if (!Array.isArray(value) || value.length > 60) throw new HisError('HIS_INVALID');
  return value.map((sample: unknown) => {
    if (!Array.isArray(sample) || sample.length !== width) throw new HisError('HIS_INVALID');
    return parse(sample);
  });
}

/** Validate and copy the snapshot; never retain arbitrary extra fields from the client. */
export function parseHis(value: unknown): HisData {
  if (value === undefined || value === null) throw new HisError('HIS_MISSING');
  const fields = ['focus', 'maxTouchPoints', 'pointer', 'scroll', 'time', 'touch'];
  if (!object(value) || Object.keys(value).length !== fields.length
    || !fields.every((key) => Object.hasOwn(value, key))) throw new HisError('HIS_INVALID');
  return {
    focus: samples(value.focus, 4, (row) => [
      integer(row[0]), integer(row[1], -2_147_483_648, 2_147_483_647),
      integer(row[2], 0, 10), integer(row[3], 0, 1),
    ]),
    maxTouchPoints: integer(value.maxTouchPoints, 0, 1024),
    pointer: samples(value.pointer, 3, (row) => [coordinate(row[0]), coordinate(row[1]), integer(row[2])]),
    scroll: samples(value.scroll, 2, (row) => [coordinate(row[0]), integer(row[1])]),
    time: integer(value.time),
    touch: samples(value.touch, 6, (row) => [
      coordinate(row[0]), coordinate(row[1]), integer(row[2]), fraction(row[3]),
      integer(row[4], 0, 10_000_000), integer(row[5], 0, 10_000_000),
    ]),
  };
}

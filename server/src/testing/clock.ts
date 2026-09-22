/**
 * The clock the second implementations share.
 *
 * Three parties read the time in the rules worth testing: the database stamps
 * rows, storage stamps the uploads it opens, and the cleanup pass measures both
 * against an age. In production all three are the same wall clock, so a test
 * that moved only one of them would be exercising a world that cannot happen.
 * One clock, handed to all three, keeps them honest — and `advance` is what
 * turns a fresh reservation into an expired one.
 */
export interface TestClock {
  now(): Date;
  /** Moves the clock forward; timestamps already taken keep their value. */
  advance(hours: number): void;
}

const HOUR_MS = 60 * 60 * 1000;

export function createTestClock(start: Date = new Date()): TestClock {
  let current = start.getTime();

  return {
    now: () => new Date(current),
    advance: (hours) => {
      current += hours * HOUR_MS;
    },
  };
}

/**
 * The wall clock every scenario reads through instead of `Date.now()` directly.
 *
 * Cleanup's "older than the TTL" rule and a reservation's `expiresAt` both read
 * time, and a module that read it for itself could never be shown obeying
 * either rule in a test. One port, handed to every scenario, is what lets a
 * harness move a single clock and have both react to it.
 *
 * Logging is not a port for the same reason in reverse: nothing here decides
 * anything by what the log carries.
 */
export interface Clock {
  now(): Date;
}

export const systemClock: Clock = {
  now: () => new Date(),
};

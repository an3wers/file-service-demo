/**
 * The failure knob the second implementations carry.
 *
 * Both of them model state rather than scripting answers, so the only thing a
 * test cannot reach by driving them normally is a dependency that refuses:
 * storage that is down, a table that rejects a row. This arms exactly one such
 * refusal, and the next call to that method spends it.
 *
 * One call, not a mode: the paths worth testing are the ones that undo a side
 * effect after a failure, and they have to be able to finish undoing it.
 */
export interface FailureSwitch<M extends string> {
  /** Throws the armed error when this is the armed method, and disarms it. */
  check(method: M): void;

  /** Makes the next call to this method fail, for the error paths. */
  failNext(method: M, error: unknown): void;
}

export function createFailureSwitch<M extends string>(): FailureSwitch<M> {
  const armed = new Map<M, unknown>();

  return {
    check(method: M): void {
      if (!armed.has(method)) {
        return;
      }

      const error = armed.get(method);

      armed.delete(method);
      throw error;
    },

    failNext(method: M, error: unknown): void {
      armed.set(method, error);
    },
  };
}

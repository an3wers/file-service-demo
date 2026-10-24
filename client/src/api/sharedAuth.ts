export interface SharedAuth {
  generation: number;
  signedIn: boolean;
}

const STATE_KEY = "file-service-auth-state";
const OWNER_KEY = "file-service-personal-owner";
const LOCK_NAME = "file-service-auth";

let known = readSharedAuth().generation;
let tail: Promise<unknown> = Promise.resolve();

export function readSharedAuth(): SharedAuth {
  try {
    const value = JSON.parse(localStorage.getItem(STATE_KEY) ?? "null");
    if (
      Number.isSafeInteger(value?.generation) &&
      typeof value.signedIn === "boolean"
    )
      return { generation: value.generation, signedIn: value.signedIn };
  } catch {
    return { generation: 0, signedIn: false };
  }

  return { generation: 0, signedIn: false };
}

export function writeSharedAuth(state: SharedAuth): void {
  known = state.generation;
  try {
    localStorage.setItem(STATE_KEY, JSON.stringify(state));
  } catch {
    return;
  }
}

export function readPersonalOwner(): string | null {
  try {
    return localStorage.getItem(OWNER_KEY);
  } catch {
    return null;
  }
}

export function writePersonalOwner(userId: string): void {
  try {
    localStorage.setItem(OWNER_KEY, userId);
  } catch {
    return;
  }
}

export function knownGeneration(): number {
  return known;
}

export function acceptGeneration(generation: number): void {
  known = generation;
}

export function exclusive<T>(run: () => Promise<T>): Promise<T> {
  if (typeof navigator !== "undefined" && navigator.locks) {
    return navigator.locks.request(LOCK_NAME, run) as Promise<T>;
  }
  const result = tail.then(run);
  tail = result.catch(() => {});
  return result;
}

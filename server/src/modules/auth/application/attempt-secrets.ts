import { createHash, createHmac } from "node:crypto";

export const secretDigest = (purpose: string, value: string) =>
  createHash("sha256").update(`${purpose}\0${value}`).digest("hex");

export const registrationAttemptDigest = (attemptToken: string) =>
  secretDigest("registration-attempt", attemptToken);

export const registrationCodeDigest = (
  codeSecret: string,
  attemptHash: string,
  code: string,
) =>
  createHmac("sha256", codeSecret)
    .update(`registration-code\0${attemptHash}\0${code}`)
    .digest("hex");

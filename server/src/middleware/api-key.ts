import { timingSafeEqual } from "node:crypto";
import type { RequestHandler } from "express";
import { config } from "../config.js";
import { unauthorized } from "../errors.js";

const expected = Buffer.from(config.apiKey, "utf8");

function matches(provided: string): boolean {
  const candidate = Buffer.from(provided, "utf8");

  // timingSafeEqual throws on a length mismatch, so guard first. The length of
  // the configured key is not a secret worth protecting here.
  return candidate.length === expected.length && timingSafeEqual(candidate, expected);
}

export const apiKeyAuth: RequestHandler = (req, _res, next) => {
  const header = req.get("x-api-key");

  if (!header || !matches(header)) {
    return next(unauthorized());
  }

  next();
};

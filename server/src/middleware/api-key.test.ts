import type { NextFunction, Request, Response } from "express";
import { describe, expect, it, vi } from "vitest";
import { config } from "../config.js";
import { AppError, ERROR_CODES } from "../errors.js";
import { apiKeyAuth } from "./api-key.js";

/** Только то, что читает middleware: заголовок запроса. */
function requestWith(apiKey?: string): Request {
  return {
    get: (name: string) => (name.toLowerCase() === "x-api-key" ? apiKey : undefined),
  } as unknown as Request;
}

function run(apiKey?: string): NextFunction {
  const next = vi.fn() as unknown as NextFunction;

  apiKeyAuth(requestWith(apiKey), {} as Response, next);

  return next;
}

describe("apiKeyAuth", () => {
  it("passes a request carrying the configured key", () => {
    expect(run(config.apiKey)).toHaveBeenCalledWith();
  });

  it("rejects a missing key", () => {
    expect(run()).toHaveBeenCalledWith(
      expect.objectContaining({ statusCode: 401, code: ERROR_CODES.UNAUTHORIZED }),
    );
  });

  it("rejects a wrong key of the same length", () => {
    const wrong = `${config.apiKey.slice(0, -1)}x`;
    const next = run(wrong) as unknown as ReturnType<typeof vi.fn>;

    expect(wrong).toHaveLength(config.apiKey.length);
    expect(next.mock.calls[0]?.[0]).toBeInstanceOf(AppError);
  });

  it("rejects a key of a different length without throwing", () => {
    expect(run(`${config.apiKey}extra`)).toHaveBeenCalledWith(expect.any(AppError));
  });
});

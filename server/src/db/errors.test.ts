import { describe, expect, it } from "vitest";
import { AppError, ERROR_CODES, notFound } from "../errors.js";
import { databaseError } from "./errors.js";

function pgError(message: string, code?: string): Error & { code?: string } {
  return Object.assign(new Error(message), code ? { code } : {});
}

describe("databaseError", () => {
  it("passes an AppError through untouched", () => {
    const original = notFound(ERROR_CODES.FILE_NOT_FOUND, "gone");

    expect(databaseError(original)).toBe(original);
  });

  it("maps a unique violation to 409", () => {
    const mapped = databaseError(
      Object.assign(pgError("duplicate key", "23505"), { constraint: "files_pkey" }),
    );

    expect(mapped).toBeInstanceOf(AppError);
    expect(mapped).toMatchObject({ statusCode: 409, code: ERROR_CODES.DUPLICATE_RESOURCE });
    expect((mapped as AppError).logContext).toMatchObject({
      pgCode: "23505",
      constraint: "files_pkey",
    });
  });

  it("maps a cancelled statement to a timeout", () => {
    expect(databaseError(pgError("canceling statement", "57014"))).toMatchObject({
      statusCode: 503,
      code: ERROR_CODES.DATABASE_TIMEOUT,
    });
  });

  it("maps SQLSTATE connection classes to unavailable", () => {
    expect(databaseError(pgError("too many clients", "53300"))).toMatchObject({
      statusCode: 503,
      code: ERROR_CODES.DATABASE_UNAVAILABLE,
    });
  });

  it("maps a socket failure to unavailable", () => {
    expect(databaseError(pgError("connect ECONNREFUSED", "ECONNREFUSED"))).toMatchObject({
      statusCode: 503,
      code: ERROR_CODES.DATABASE_UNAVAILABLE,
    });
  });

  it("recognises a bare pg failure by its message", () => {
    expect(databaseError(pgError("Connection terminated unexpectedly"))).toMatchObject({
      statusCode: 503,
      code: ERROR_CODES.DATABASE_UNAVAILABLE,
    });
  });

  it("looks down the cause chain", () => {
    const wrapped = new Error("query failed", { cause: pgError("read ECONNRESET", "ECONNRESET") });

    expect(databaseError(wrapped)).toMatchObject({ code: ERROR_CODES.DATABASE_UNAVAILABLE });
  });

  it("returns a programming error unchanged so it surfaces as a 500", () => {
    const syntax = pgError("syntax error at or near", "42601");

    expect(databaseError(syntax)).toBe(syntax);
  });
});

import { describe, expect, it } from "vitest";
import { ERROR_CODES } from "../../errors.js";
import { FileTooLargeError, InvalidPlanLimitsError } from "./errors.js";
import { needsMultipart, partRange, planMultipart } from "./upload-plan.js";
import type { PlanLimits } from "./upload-plan.js";

const MIB = 1024 * 1024;
const GIB = 1024 * MIB;

/** Возвращает выброшенную ошибку, чтобы проверить её код, а не только факт броска. */
function thrownBy(run: () => unknown): Error {
  try {
    run();
  } catch (error) {
    return error as Error;
  }

  throw new Error("Expected the call to throw, but it returned");
}

/** Значения по умолчанию из config; продублированы, чтобы тест не зависел от .env. */
const limits: PlanLimits = {
  partSize: 16 * MIB,
  minPartSize: 5 * MIB,
  maxPartSize: 5 * 1024 * MIB,
  maxParts: 10_000,
  maxObjectSize: 200 * GIB,
};

describe("needsMultipart", () => {
  it("keeps a request without a size on the single-PUT path", () => {
    expect(needsMultipart(undefined, 100 * MIB)).toBe(false);
  });

  it("switches exactly at the threshold, not one byte later", () => {
    expect(needsMultipart(100 * MIB - 1, 100 * MIB)).toBe(false);
    expect(needsMultipart(100 * MIB, 100 * MIB)).toBe(true);
  });
});

describe("planMultipart", () => {
  it("reproduces the documented split table", () => {
    expect(planMultipart(100 * MIB, limits)).toMatchObject({
      partSize: 16 * MIB,
      partCount: 7,
      lastPartSize: 4 * MIB,
    });
    expect(planMultipart(GIB, limits)).toMatchObject({ partSize: 16 * MIB, partCount: 64 });
    expect(planMultipart(10 * GIB, limits)).toMatchObject({ partSize: 16 * MIB, partCount: 640 });
    expect(planMultipart(160 * GIB, limits)).toMatchObject({
      partSize: 17 * MIB,
      partCount: 9638,
    });
  });

  it("leaves the last part full when the size divides evenly", () => {
    const plan = planMultipart(64 * MIB, limits);

    expect(plan).toMatchObject({ partCount: 4, lastPartSize: 16 * MIB });
  });

  it("accepts a last part below the 5 MiB floor", () => {
    // The minimum applies to every part except the last, so this is a valid
    // plan rather than something to round away.
    const plan = planMultipart(16 * MIB + 1, limits);

    expect(plan).toMatchObject({ partCount: 2, lastPartSize: 1 });
  });

  it("grows the part instead of exceeding maxParts", () => {
    const plan = planMultipart(100 * MIB, { ...limits, maxParts: 3 });

    expect(plan.partCount).toBeLessThanOrEqual(3);
    expect(plan.partSize).toBeGreaterThan(limits.partSize);
    expect(plan.partSize % MIB).toBe(0);
  });

  it("never drops below the protocol minimum part size", () => {
    const plan = planMultipart(6 * MIB, { ...limits, partSize: limits.minPartSize });

    expect(plan.partSize).toBeGreaterThanOrEqual(limits.minPartSize);
  });

  it("keeps partCount within maxParts across a range of sizes", () => {
    for (const size of [5 * MIB, 100 * MIB, 7 * GIB, 160 * GIB, 200 * GIB]) {
      expect(planMultipart(size, limits).partCount).toBeLessThanOrEqual(limits.maxParts);
    }
  });

  it("rejects a size past the object ceiling", () => {
    expect(thrownBy(() => planMultipart(201 * GIB, limits))).toBeInstanceOf(FileTooLargeError);
  });

  it("rejects a size that is not a positive number", () => {
    for (const size of [0, -1, Number.NaN]) {
      expect(thrownBy(() => planMultipart(size, limits))).toMatchObject({
        statusCode: 400,
        code: ERROR_CODES.INVALID_UPLOAD_SIZE,
      });
    }
  });

  describe("пределы, которые домену передала сборка", () => {
    it("бросает доменную ошибку, когда предел частей не положителен", () => {
      expect(
        thrownBy(() => planMultipart(100 * MIB, { ...limits, maxParts: 0 })),
      ).toBeInstanceOf(InvalidPlanLimitsError);
    });

    it("бросает доменную ошибку, когда верхняя граница части меньше нижней", () => {
      expect(
        thrownBy(() =>
          planMultipart(100 * MIB, { ...limits, minPartSize: 10 * MIB, maxPartSize: 5 * MIB }),
        ),
      ).toBeInstanceOf(InvalidPlanLimitsError);
    });

    it("бросает доменную ошибку, когда потолок объекта не положителен", () => {
      expect(
        thrownBy(() => planMultipart(100 * MIB, { ...limits, maxObjectSize: 0 })),
      ).toBeInstanceOf(InvalidPlanLimitsError);
    });
  });
});

describe("partRange", () => {
  it("tiles the file without gaps or overlaps", () => {
    const plan = planMultipart(100 * MIB, limits);
    let expectedOffset = 0;
    let total = 0;

    for (let partNumber = 1; partNumber <= plan.partCount; partNumber += 1) {
      const range = partRange(plan, partNumber);

      expect(range.offset).toBe(expectedOffset);
      expectedOffset += range.size;
      total += range.size;
    }

    expect(total).toBe(plan.size);
  });

  it("shortens the last part only", () => {
    const plan = planMultipart(100 * MIB, limits);

    expect(partRange(plan, 1)).toEqual({ offset: 0, size: 16 * MIB });
    expect(partRange(plan, 6)).toEqual({ offset: 5 * 16 * MIB, size: 16 * MIB });
    expect(partRange(plan, 7)).toEqual({ offset: 6 * 16 * MIB, size: 4 * MIB });
  });
});

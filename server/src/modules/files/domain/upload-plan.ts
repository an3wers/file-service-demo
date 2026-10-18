import {
  FileTooLargeError,
  InvalidPlanLimitsError,
  InvalidUploadSizeError,
} from "./errors.js";

const MIB = 1024 * 1024;

/**
 * Ограничения, которые политика развёртывания передаёт построителю плана.
 * `minPartSize` и `maxPartSize` задаются протоколом составной загрузки.
 * Они объявлены рядом с адаптером (`PROTOCOL_LIMITS` в
 * `storage/s3-object-store.ts`) и ограничивают конфигурацию при сборке.
 * Домен получает готовые пределы и проверяет их согласованность
 * перед построением плана.
 */
export interface PlanLimits {
  /** Желаемый размер части; увеличивается, если файл не помещается в `maxParts`. */
  partSize: number;
  /** Нижняя граница для всех частей, кроме последней, чей размер может быть любым. */
  minPartSize: number;
  maxPartSize: number;
  maxParts: number;
  maxObjectSize: number;
}

/**
 * Пределы приходят извне, поэтому домен проверяет их согласованность.
 * Иначе неверная конфигурация даст план, который отклонит хранилище
 * или который неверно покрывает файл. Проверка экспортируется для запуска
 * при сборке и дополнительно выполняется при каждом `planMultipart`.
 */
export function assertValidPlanLimits(limits: PlanLimits): void {
  const sane =
    Number.isFinite(limits.minPartSize) &&
    limits.minPartSize > 0 &&
    Number.isFinite(limits.maxPartSize) &&
    limits.maxPartSize >= limits.minPartSize &&
    Number.isFinite(limits.partSize) &&
    limits.partSize > 0 &&
    Number.isFinite(limits.maxParts) &&
    limits.maxParts > 0 &&
    Number.isFinite(limits.maxObjectSize) &&
    limits.maxObjectSize > 0;

  if (!sane) {
    throw new InvalidPlanLimitsError("Upload plan limits are not sane", {
      limits,
    });
  }
}

export interface UploadPlan {
  size: number;
  partSize: number;
  partCount: number;
  lastPartSize: number;
}

export interface PartRange {
  offset: number;
  size: number;
}

function ceilTo(value: number, step: number): number {
  return Math.ceil(value / step) * step;
}

/** Нужна ли для файла такого размера составная загрузка вместо одного PUT. */
export function needsMultipart(
  size: number | undefined,
  threshold: number,
): boolean {
  return size !== undefined && size >= threshold;
}

/**
 * Определяет разбиение файла на части: клиент передаёт размер и получает
 * готовый план, которому должен следовать.
 *
 * Пределы задаются политикой развёртывания и передаются явно, без значений
 * по умолчанию, чтобы построение плана не зависело от окружения в тестах.
 */
export function planMultipart(size: number, limits: PlanLimits): UploadPlan {
  assertValidPlanLimits(limits);

  if (!Number.isFinite(size) || size <= 0) {
    throw new InvalidUploadSizeError(
      "File size must be a positive number of bytes",
    );
  }

  if (size > limits.maxObjectSize) {
    throw new FileTooLargeError(
      `File exceeds the ${Math.floor(limits.maxObjectSize / (1024 * MIB))} GB limit for a single object`,
      { maxObjectSize: limits.maxObjectSize },
    );
  }

  let partSize = limits.partSize;

  if (Math.ceil(size / partSize) > limits.maxParts) {
    // Округляем необходимый размер вверх до целого МиБ, чтобы из-за округления
    // количество частей не превысило предел на одну часть.
    partSize = ceilTo(Math.ceil(size / limits.maxParts), MIB);
  }

  partSize = Math.min(
    Math.max(partSize, limits.minPartSize),
    limits.maxPartSize,
  );

  const partCount = Math.ceil(size / partSize);

  if (partCount > limits.maxParts) {
    // Недостижимо при `maxObjectSize` не больше 5 ТиБ: 10 000 частей по 5 ГиБ
    // вмещают около 50 ТиБ. Проверка оставлена на случай увеличения лимита.
    throw new FileTooLargeError(
      "File cannot be split into parts within the protocol limits",
      {
        maxParts: limits.maxParts,
      },
    );
  }

  return {
    size,
    partSize,
    partCount,
    // Может быть меньше `minPartSize`: нижняя граница 5 МиБ
    // не применяется к последней части.
    lastPartSize: size - (partCount - 1) * partSize,
  };
}

/** Диапазон байтов части, который клиент передаёт в `file.slice()`. */
export function partRange(plan: UploadPlan, partNumber: number): PartRange {
  const offset = (partNumber - 1) * plan.partSize;

  return {
    offset,
    size: partNumber === plan.partCount ? plan.lastPartSize : plan.partSize,
  };
}

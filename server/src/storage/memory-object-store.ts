import { createHash, randomUUID } from "node:crypto";
import { createTestClock } from "../testing/clock.js";
import type { TestClock } from "../testing/clock.js";
import { createFailureSwitch } from "../testing/failure-switch.js";
import type {
  CompleteOutcome,
  MultipartUpload,
  ObjectStore,
  StoredObject,
  UploadedPart,
} from "./object-store.js";

/**
 * Адаптер хранилища на Map воспроизводит нужное сервису поведение S3.
 *
 * Хранит состояние, чтобы тесты проверяли результат загрузки, а не только
 * вызовы методов. Правила, на которые опирается код:
 *
 * - части возвращаются по возрастанию номера;
 * - завершённая или отменённая загрузка исчезает, последующие обращения
 *   сообщают об её отсутствии;
 * - объект по ключу появляется только после сборки;
 * - ETag заключён в кавычки и возвращается при завершении без изменений;
 * - время открытия загрузки позволяет уборке определить возраст сироты.
 *
 * Часы передаются извне, чтобы хранилище и таблица метаданных использовали
 * одно время: загрузка и её резервирование должны стареть согласованно.
 *
 * Подписанные ссылки условные: их можно проверить, но нельзя использовать
 * для передачи байтов. В тесте действия клиента выполняются через
 * `uploadObject` и `uploadPart`.
 */

interface StoredBytes {
  body: Buffer;
  contentType: string;
}

interface OpenUpload {
  key: string;
  contentType: string;
  initiatedAt: Date;
  parts: Map<number, { body: Buffer; etag: string }>;
}

/** S3 заключает ETag в кавычки; при завершении они передаются обратно вместе с кавычками. */
function etagOf(body: Buffer): string {
  return `"${createHash("md5").update(body).digest("hex")}"`;
}

export interface MemoryObjectStore extends ObjectStore {
  /** Действие клиента по ссылке, полученной через `signUpload`. */
  uploadObject(key: string, body: Buffer, contentType?: string): void;
  /** Действие клиента по ссылке, полученной через `signPart`. */
  uploadPart(uploadId: string, partNumber: number, body: Buffer): void;
  objectAt(key: string): StoredBytes | null;
  /** Все объектные ключи с сохранёнными байтами для проверки отсутствия сирот. */
  objectKeys(): string[];
  openUploads(): MultipartUpload[];
  /** Отклоняет следующий вызов этого метода для проверки обработки ошибок. */
  failNext(method: keyof ObjectStore, error: unknown): void;
}

export function createMemoryObjectStore(
  options: { clock?: TestClock } = {},
): MemoryObjectStore {
  const objects = new Map<string, StoredBytes>();
  const uploads = new Map<string, OpenUpload>();
  const clock = options.clock ?? createTestClock();
  const failures = createFailureSwitch<keyof ObjectStore>();

  /** Загрузку ищем по идентификатору: поиск по устаревшему ключу мог бы найти другую загрузку. */
  const openUpload = (uploadId: string): OpenUpload | undefined =>
    uploads.get(uploadId);

  const sign = (
    key: string,
    params: Record<string, string | number>,
  ): string => {
    const url = new URL(`https://memory.storage.test/${key}`);

    for (const [name, value] of Object.entries(params)) {
      url.searchParams.set(name, String(value));
    }

    return url.toString();
  };

  return {
    async checkAvailable(): Promise<void> {
      failures.check("checkAvailable");
    },

    async put(key, body, options) {
      failures.check("put");

      const stored = {
        body: Buffer.from(body),
        contentType: options.contentType,
      };

      objects.set(key, stored);

      return { etag: etagOf(stored.body) };
    },

    async head(key): Promise<StoredObject | null> {
      failures.check("head");

      const stored = objects.get(key);

      if (!stored) {
        return null;
      }

      return {
        size: stored.body.byteLength,
        etag: etagOf(stored.body),
        contentType: stored.contentType,
      };
    },

    async remove(key): Promise<void> {
      failures.check("remove");
      objects.delete(key);
    },

    async signUpload(key, options): Promise<string> {
      failures.check("signUpload");

      return sign(key, {
        op: "put",
        contentType: options.contentType,
        expiresIn: options.expiresIn,
      });
    },

    async signDownload(key, options): Promise<string> {
      failures.check("signDownload");

      return sign(key, {
        op: "get",
        name: options.name,
        disposition: options.disposition,
        expiresIn: options.expiresIn,
      });
    },

    async beginMultipart(key, options): Promise<string> {
      failures.check("beginMultipart");

      const uploadId = randomUUID();

      uploads.set(uploadId, {
        key,
        contentType: options.contentType,
        initiatedAt: clock.now(),
        parts: new Map(),
      });

      return uploadId;
    },

    async signPart(key, uploadId, partNumber, options): Promise<string> {
      failures.check("signPart");

      return sign(key, {
        op: "part",
        uploadId,
        partNumber,
        expiresIn: options.expiresIn,
      });
    },

    async listParts(_key, uploadId): Promise<UploadedPart[] | null> {
      failures.check("listParts");

      const upload = openUpload(uploadId);

      if (!upload) {
        return null;
      }

      return [...upload.parts.entries()]
        .map(([partNumber, part]) => ({
          partNumber,
          size: part.body.byteLength,
          etag: part.etag,
        }))
        .sort((a, b) => a.partNumber - b.partNumber);
    },

    async completeMultipart(key, uploadId, parts): Promise<CompleteOutcome> {
      failures.check("completeMultipart");

      const upload = openUpload(uploadId);

      if (!upload) {
        return "gone";
      }

      const bodies = parts.map((part) => {
        const held = upload.parts.get(part.partNumber);

        if (!held) {
          throw new Error(
            `Part ${part.partNumber} was never uploaded; completing with it would corrupt the object`,
          );
        }

        return held.body;
      });

      objects.set(key, {
        body: Buffer.concat(bodies),
        contentType: upload.contentType,
      });
      uploads.delete(uploadId);

      return "assembled";
    },

    async abortMultipart(_key, uploadId): Promise<void> {
      failures.check("abortMultipart");
      uploads.delete(uploadId);
    },

    async listMultipartUploads(): Promise<MultipartUpload[]> {
      failures.check("listMultipartUploads");

      return [...uploads.entries()].map(([uploadId, upload]) => ({
        uploadId,
        key: upload.key,
        initiatedAt: upload.initiatedAt,
      }));
    },

    uploadObject(key, body, contentType = "application/octet-stream"): void {
      objects.set(key, { body: Buffer.from(body), contentType });
    },

    uploadPart(uploadId, partNumber, body): void {
      const upload = openUpload(uploadId);

      if (!upload) {
        throw new Error(`No multipart upload ${uploadId} is open`);
      }

      const stored = Buffer.from(body);

      upload.parts.set(partNumber, { body: stored, etag: etagOf(stored) });
    },

    objectAt(key): StoredBytes | null {
      return objects.get(key) ?? null;
    },

    objectKeys(): string[] {
      return [...objects.keys()].sort();
    },

    openUploads(): MultipartUpload[] {
      return [...uploads.entries()].map(([uploadId, upload]) => ({
        uploadId,
        key: upload.key,
        initiatedAt: upload.initiatedAt,
      }));
    },

    failNext(method, error): void {
      failures.failNext(method, error);
    },
  };
}

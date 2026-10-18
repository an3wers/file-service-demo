import type {
  CompleteOutcome,
  MultipartUpload,
  PutOptions,
  SignDownloadOptions,
  SignUploadOptions,
  StoredObject,
  UploadedPart,
} from "../../../../storage/object-store.js";

/**
 * Шов между сценариями и объектным хранилищем, сужённый так же, как интерфейсы
 * строк в `file-rows.ts`: сценарий берёт только те операции, которые зовёт.
 * Уборка не подписывает ссылок, а тестовому двойнику достаточно отвечать за свой срез.
 *
 * Адаптер за всеми тремя интерфейсами один: общий `ObjectStore` структурно
 * подходит под каждый, и сборка передаёт всем сценариям один экземпляр.
 */

/** Storage as the files module handles it: put, confirm, sign, remove. */
export interface ObjectStoreForFiles {
  put(
    key: string,
    body: Buffer,
    options: PutOptions,
  ): Promise<{ etag: string | null }>;

  /** `null` when no object exists at the key. */
  head(key: string): Promise<StoredObject | null>;

  /** Succeeds whether or not an object was there. */
  remove(key: string): Promise<void>;

  signUpload(key: string, options: SignUploadOptions): Promise<string>;

  signDownload(key: string, options: SignDownloadOptions): Promise<string>;

  /** Cancels an upload in flight, for a delete that catches a live multipart file. */
  abortMultipart(key: string, uploadId: string): Promise<void>;
}

/** Хранилище для составной загрузки: открыть, подписать, собрать, отменить. */
export interface ObjectStoreForMultipart {
  beginMultipart(
    key: string,
    options: { contentType: string },
  ): Promise<string>;

  signPart(
    key: string,
    uploadId: string,
    partNumber: number,
    options: { expiresIn: number },
  ): Promise<string>;

  /** `null` when no upload answers to the id. */
  listParts(key: string, uploadId: string): Promise<UploadedPart[] | null>;

  completeMultipart(
    key: string,
    uploadId: string,
    parts: UploadedPart[],
  ): Promise<CompleteOutcome>;

  abortMultipart(key: string, uploadId: string): Promise<void>;
}

/** Storage as the cleanup pass handles it: check, inspect, cancel, list. */
export interface ObjectStoreForCleanup {
  head(key: string): Promise<StoredObject | null>;

  listParts(key: string, uploadId: string): Promise<UploadedPart[] | null>;

  abortMultipart(key: string, uploadId: string): Promise<void>;

  /** Every upload storage still holds open, for the orphan sweep. */
  listMultipartUploads(): Promise<MultipartUpload[]>;
}

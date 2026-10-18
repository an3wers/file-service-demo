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

/** Объектное хранилище для загрузки, подтверждения, подписывания и удаления файлов. */
export interface ObjectStoreForFiles {
  put(
    key: string,
    body: Buffer,
    options: PutOptions,
  ): Promise<{ etag: string | null }>;

  /** `null`, если по ключу нет объекта. */
  head(key: string): Promise<StoredObject | null>;

  /** Завершается успешно, даже если объекта не было. */
  remove(key: string): Promise<void>;

  signUpload(key: string, options: SignUploadOptions): Promise<string>;

  signDownload(key: string, options: SignDownloadOptions): Promise<string>;

  /** Отменяет живую составную загрузку при удалении файла. */
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

  /** `null`, если загрузки с таким идентификатором нет. */
  listParts(key: string, uploadId: string): Promise<UploadedPart[] | null>;

  completeMultipart(
    key: string,
    uploadId: string,
    parts: UploadedPart[],
  ): Promise<CompleteOutcome>;

  abortMultipart(key: string, uploadId: string): Promise<void>;
}

/** Объектное хранилище для проверки, просмотра и отмены загрузок при уборке. */
export interface ObjectStoreForCleanup {
  head(key: string): Promise<StoredObject | null>;

  listParts(key: string, uploadId: string): Promise<UploadedPart[] | null>;

  abortMultipart(key: string, uploadId: string): Promise<void>;

  /** Все открытые загрузки в хранилище для поиска сирот. */
  listMultipartUploads(): Promise<MultipartUpload[]>;
}

import type { StoredFile, FileStatus, UploadSource } from "../stored-file.js";

/** Поля `bucket` нет: сохраняющий строку адаптер берёт его из своих настроек. */
export interface InsertFileInput {
  id: string;
  objectKey: string;
  directory: string;
  originalName: string;
  extension: string;
  contentType: string;
  sizeBytes: number | null;
  etag: string | null;
  status: FileStatus;
  uploadSource: UploadSource;
  uploadId?: string | null;
  partSize?: number | null;
  partCount?: number | null;
}

export interface ListFilesParams {
  directory?: string;
  recursive: boolean;
  search?: string;
  status?: FileStatus;
  page: number;
  limit: number;
  sort: "created_at" | "original_name" | "size_bytes";
  order: "asc" | "desc";
}

/** Данные завершённой загрузки, необходимые для подтверждения. */
export interface ReadyValues {
  sizeBytes: number | null;
  etag: string | null;
  contentType: string;
}

/** Строки метаданных для резервирования, подтверждения, просмотра и удаления файлов. */
export interface FileRowsForFiles {
  markFileFailed(id: string): Promise<void>;
  failFileIfUnchanged(expected: StoredFile): Promise<boolean>;
  reserveFile(input: InsertFileInput): Promise<StoredFile>;
  isFileDeleted(id: string): Promise<boolean>;
  insertFile(input: InsertFileInput): Promise<StoredFile>;

  /** `null`, если строка не существовала или помечена удалённой. */
  findFileById(id: string): Promise<StoredFile | null>;

  /**
   * Переводит зарезервированную строку в `ready` и очищает план составной загрузки.
   * Возвращает `null`, если строка исчезла; вызывающий код отличает этот случай
   * от успешного подтверждения.
   */
  markFileReady(id: string, values: ReadyValues): Promise<StoredFile | null>;

  /** `null`, если строка уже удалена; повторное удаление не считается ошибкой. */
  softDeleteFile(id: string): Promise<StoredFile | null>;

  /** Страница результатов и общее количество строк. */
  listFiles(
    params: ListFilesParams,
  ): Promise<{ items: StoredFile[]; total: number }>;
}

/** Строки для составной загрузки: допуск, затем резервирование. */
export interface FileRowsForMultipart {
  reserveFile(input: InsertFileInput): Promise<StoredFile>;
  /** Слоты загрузок, которые ещё не завершены и не отменены. */
  countActiveMultipart(): Promise<number>;
}

/** Строки метаданных для поиска и обработки просроченных загрузок при уборке. */
export interface FileRowsForCleanup {
  /** Просроченные резервирования, начиная с самых старых. */
  listExpiredPending(ttlHours: number): Promise<StoredFile[]>;

  /**
   * Идентификаторы загрузок, известные таблице метаданных. Уборка считает
   * остальные загрузки сиротами, поэтому проверяются все строки, включая
   * удалённые и уже обработанные.
   */
  findKnownUploadIds(ids: string[]): Promise<Set<string>>;
}

/** Всё, что сценарии вместе требуют от строк. */
export type FileRows = FileRowsForFiles &
  FileRowsForMultipart &
  FileRowsForCleanup;

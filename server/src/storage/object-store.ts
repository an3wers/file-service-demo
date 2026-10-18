/**
 * Граница между сервисом и хранилищем байтов.
 *
 * SDK, подписывание, пагинация и варианты ответа об отсутствии объекта
 * остаются в адаптере. Вызывающий код работает с объектными ключами;
 * бакетом управляет адаптер.
 *
 * Сбои передаются как `AppError`. Отсутствие объекта по ключу или загрузки
 * по идентификатору передаётся значением: один сценарий подтверждения
 * вернёт 409, а другой проверит, не собрана ли загрузка ранее.
 */

/** Данные существующего объекта, известные хранилищу. */
export interface StoredObject {
  size: number | null;
  etag: string | null;
  contentType: string | null;
}

/** Часть, которую хранилище уже приняло для живой составной загрузки. */
export interface UploadedPart {
  partNumber: number;
  size: number;
  etag: string;
}

/** Открытая составная загрузка, доступная уборке для поиска сирот. */
export interface MultipartUpload {
  key: string;
  uploadId: string;
  initiatedAt: Date | null;
}

export interface PutOptions {
  contentType: string;
  contentLength: number;
}

export interface SignUploadOptions {
  contentType: string;
  expiresIn: number;
}

export interface SignDownloadOptions {
  /** Имя, под которым браузер должен сохранить файл. */
  name: string;
  contentType: string;
  disposition: "attachment" | "inline";
  expiresIn: number;
}

/**
 * Результат сборки здесь или обнаружения уже завершённой загрузки.
 * `"gone"` не считается ошибкой: потеря ответа и параллельное подтверждение
 * дают такой результат. Вызывающий код проверяет сам объект.
 */
export type CompleteOutcome = "assembled" | "gone";

export interface ObjectStore {
  /** Проверка готовности: хранилище доступно и бакет существует. */
  checkAvailable(): Promise<void>;

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

  /** Открывает загрузку и возвращает идентификатор для последующих вызовов. */
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

  /**
   * Все сохранённые части загрузки по возрастанию номера.
   * `null`, если загрузки с таким идентификатором нет.
   */
  listParts(key: string, uploadId: string): Promise<UploadedPart[] | null>;

  /** Собирает объект из переданных частей в указанном порядке. */
  completeMultipart(
    key: string,
    uploadId: string,
    parts: UploadedPart[],
  ): Promise<CompleteOutcome>;

  /** Отменяет живую составную загрузку; отсутствие загрузки не считается ошибкой. */
  abortMultipart(key: string, uploadId: string): Promise<void>;

  /**
   * Все открытые загрузки бакета для поиска сирот при уборке.
   * Их количество ограничено лимитом активных загрузок и остатками после сбоев,
   * поэтому список возвращается целиком.
   */
  listMultipartUploads(): Promise<MultipartUpload[]>;
}

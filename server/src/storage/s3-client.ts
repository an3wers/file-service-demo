import { S3Client } from "@aws-sdk/client-s3";

/**
 * Создаёт клиент SDK для адаптера S3 и сосредотачивает особенности
 * конкретного сервиса хранилища. Клиент доступен только адаптеру
 * и коду сборки зависимостей.
 */
export interface S3ClientOptions {
  endpoint: string;
  region: string;
  accessKeyId: string;
  secretAccessKey: string;
}

export function createS3Client(options: S3ClientOptions): S3Client {
  return new S3Client({
    region: options.region,
    endpoint: options.endpoint,
    // Cloud.ru находит бакеты только при передаче имени в пути;
    // адрес вида <bucket>.s3.cloud.ru возвращает NoSuchBucket.
    forcePathStyle: true,
    // Новые версии SDK по умолчанию добавляют x-amz-checksum-* и кодирование
    // aws-chunked. Браузер их не повторяет, поэтому подписанный с ними PUT
    // завершается ошибкой SignatureDoesNotMatch или UnsignedHeaders.
    requestChecksumCalculation: "WHEN_REQUIRED",
    responseChecksumValidation: "WHEN_REQUIRED",
    maxAttempts: 3,
    // Явные тайм-ауты ограничивают ожидание зависшего хранилища и позволяют
    // `storageError` преобразовать TimeoutError в 503. Параметр `requestTimeout`
    // ограничивает простой сокета, а не общую длительность запроса,
    // поэтому подходит и для больших загрузок через сервер.
    requestHandler: {
      connectionTimeout: 3_000,
      requestTimeout: 30_000,
    },
    credentials: {
      accessKeyId: options.accessKeyId,
      secretAccessKey: options.secretAccessKey,
    },
  });
}

import type { ZodOpenApiPathsObject } from "zod-openapi";
import { apiErrors } from "../../../../http-contract.js";
import {
  createDirectorySchema,
  directoriesQuerySchema,
  downloadUrlQuerySchema,
  fileCardQuerySchema,
  idParamsSchema,
  listFilesQuerySchema,
  partUrlsSchema,
  presignUploadSchema,
  uploadFormSchema,
  resolveUploadSchema,
} from "./schemas.js";
import {
  uploadOperationResponseSchema,
  directoriesResponseSchema,
  directoryDtoSchema,
  downloadUrlResponseSchema,
  fileDtoSchema,
  listFilesResponseSchema,
  multipartStatusResponseSchema,
  partUrlsResponseSchema,
  presignUploadResponseSchema,
} from "./responses.js";

const json = <T>(schema: T) => ({ "application/json": { schema } });

const FILE_NOT_FOUND = "Файла нет или он удалён";

export const filesPaths: ZodOpenApiPathsObject = {
  "/upload-operations/{id}/resolve": {
    post: {
      tags: ["uploads"],
      summary: "Сверить операцию загрузки с объектным хранилищем",
      operationId: "resolveUploadOperation",
      requestParams: { path: idParamsSchema },
      requestBody: { required: false, content: json(resolveUploadSchema) },
      responses: {
        200: {
          description: "Результат сверки операции",
          content: json(uploadOperationResponseSchema),
        },
        ...apiErrors({ 503: "Объектное хранилище временно недоступно" }),
      },
    },
  },
  "/upload-operations/{id}/fail": {
    post: {
      tags: ["uploads"],
      summary: "Завершить неудавшуюся операцию и очистить остатки",
      operationId: "failUploadOperation",
      requestParams: { path: idParamsSchema },
      responses: {
        200: {
          description: "Состояние операции после очистки",
          content: json(uploadOperationResponseSchema),
        },
        ...apiErrors({ 400: "Недопустимый идентификатор" }),
      },
    },
  },
  "/upload-operations/{id}/cancel": {
    post: {
      tags: ["uploads"],
      summary: "Отменить операцию и удалить загруженные данные",
      operationId: "cancelUploadOperation",
      requestParams: { path: idParamsSchema },
      responses: {
        200: {
          description: "Состояние отмены и очистки",
          content: json(uploadOperationResponseSchema),
        },
        ...apiErrors({ 409: "Операция обрабатывается" }),
      },
    },
  },
  "/upload-operations/{id}": {
    get: {
      tags: ["uploads"],
      summary: "Прочитать сохранённый результат операции загрузки",
      operationId: "getUploadOperation",
      requestParams: { path: idParamsSchema },
      responses: {
        200: {
          description: "Состояние операции",
          content: json(uploadOperationResponseSchema),
        },
        ...apiErrors({ 400: "Недопустимый идентификатор" }),
      },
    },
  },
  "/": {
    post: {
      tags: ["files"],
      summary: "Загрузить файл через сервер",
      description:
        "Файл целиком буферизуется в памяти сервера и ограничен MAX_UPLOAD_SIZE_MB. " +
        "Файлы крупнее грузятся через /presign-upload. " +
        "operationId задаёт устойчивую идентичность: повтор с тем же UUID возвращает прежний файл, " +
        "а после удаления — 404. Без operationId каждый запрос создаёт новую операцию. " +
        "Перед повторной передачей выясните состояние через POST /upload-operations/{id}/resolve.",
      operationId: "uploadFile",
      requestBody: {
        required: true,
        content: { "multipart/form-data": { schema: uploadFormSchema } },
      },
      responses: {
        201: { description: "Файл сохранён", content: json(fileDtoSchema) },
        ...apiErrors({
          404: "Директория не найдена",
          400: "Нет поля file, лишние поля формы, недопустимое имя или каталог",
          413: "Файл больше лимита загрузки через сервер",
          409: "Операция обрабатывается или параметры повтора отличаются",
        }),
      },
    },
    get: {
      tags: ["files"],
      summary: "Список файлов",
      operationId: "listFiles",
      requestParams: { query: listFilesQuerySchema },
      responses: {
        200: {
          description: "Страница списка",
          content: json(listFilesResponseSchema),
        },
        ...apiErrors({
          400: "Недопустимый каталог",
          404: "Директория не найдена",
        }),
      },
    },
  },
  "/presign-upload": {
    post: {
      tags: ["uploads"],
      summary: "Зарезервировать файл и получить подписанные ссылки",
      description:
        "Шаг 1 загрузки в обход сервера. До порога составной загрузки — одна ссылка для PUT " +
        "(strategy = single), после — план и первая пачка ссылок на части (strategy = multipart). " +
        "Повтор с тем же operationId сохраняет файл и план; готовый результат возвращается со strategy = ready. " +
        "После удаления результата возвращается 404. Перед новой передачей выясните исход операции.",
      operationId: "presignUpload",
      requestBody: { required: true, content: json(presignUploadSchema) },
      responses: {
        201: {
          description: "Файл зарезервирован",
          content: json(presignUploadResponseSchema),
        },
        ...apiErrors({
          400: "Недопустимое имя или каталог",
          404: "Директория не найдена",
          413: "Файл больше потолка размера объекта",
          429: "Слишком много незавершённых составных загрузок",
          409: "Операция обрабатывается или параметры повтора отличаются",
        }),
      },
    },
  },
  "/{id}/multipart/part-urls": {
    post: {
      tags: ["uploads"],
      summary: "Следующая пачка ссылок на части",
      description:
        "Этим же вызовом перевыпускаются ссылки, срок которых истёк.",
      operationId: "getPartUrls",
      requestParams: { path: idParamsSchema },
      requestBody: { required: true, content: json(partUrlsSchema) },
      responses: {
        200: {
          description: "Ссылки на запрошенные части",
          content: json(partUrlsResponseSchema),
        },
        ...apiErrors({
          400: "Номеров больше, чем подписывается за раз, или номер вне плана",
          404: FILE_NOT_FOUND,
          409: "У файла нет живой составной загрузки",
        }),
      },
    },
  },
  "/{id}/multipart": {
    get: {
      tags: ["uploads"],
      summary: "Что уже лежит в хранилище по составной загрузке",
      description: "По ответу прерванная загрузка догружает недостающие части.",
      operationId: "getMultipartStatus",
      requestParams: { path: idParamsSchema },
      responses: {
        200: {
          description: "Загруженные части",
          content: json(multipartStatusResponseSchema),
        },
        ...apiErrors({
          404: FILE_NOT_FOUND,
          409: "У файла нет живой составной загрузки",
        }),
      },
    },
  },
  "/{id}": {
    get: {
      tags: ["files"],
      summary: "Карточка файла",
      operationId: "getFile",
      requestParams: { path: idParamsSchema, query: fileCardQuerySchema },
      responses: {
        200: {
          description:
            "Карточка файла; downloadUrl есть только у готового файла при withUrl=true",
          content: json(fileDtoSchema),
        },
        ...apiErrors({ 404: FILE_NOT_FOUND }),
      },
    },
    delete: {
      tags: ["files"],
      summary: "Удалить файл",
      operationId: "deleteFile",
      requestParams: { path: idParamsSchema },
      responses: {
        204: { description: "Файл удалён" },
        ...apiErrors({ 404: FILE_NOT_FOUND }),
      },
    },
  },
  "/{id}/complete": {
    post: {
      tags: ["uploads"],
      summary: "Подтвердить загрузку",
      description:
        "Шаг 2 загрузки в обход сервера: размер и ETag сверяются с хранилищем. Составная " +
        "загрузка собирается здесь же. Повторное подтверждение — не ошибка.",
      operationId: "completeUpload",
      requestParams: { path: idParamsSchema },
      responses: {
        200: { description: "Файл готов", content: json(fileDtoSchema) },
        ...apiErrors({
          404: FILE_NOT_FOUND,
          409: "Объекта ещё нет в хранилище или загружены не все части",
        }),
      },
    },
  },
  "/{id}/download-url": {
    get: {
      tags: ["files"],
      summary: "Подписанная ссылка на скачивание",
      operationId: "getDownloadUrl",
      requestParams: { path: idParamsSchema, query: downloadUrlQuerySchema },
      responses: {
        200: {
          description: "Ссылка на скачивание",
          content: json(downloadUrlResponseSchema),
        },
        ...apiErrors({
          404: FILE_NOT_FOUND,
          409: "Файл ещё не готов",
        }),
      },
    },
  },
};

export const directoriesPaths: ZodOpenApiPathsObject = {
  "/": {
    post: {
      tags: ["directories"],
      summary: "Создать каталог внутри существующего родителя",
      operationId: "createDirectory",
      requestBody: { required: true, content: json(createDirectorySchema) },
      responses: {
        201: {
          description: "Каталог создан",
          content: json(directoryDtoSchema),
        },
        ...apiErrors({
          400: "Недопустимое имя или каталог",
          404: "Директория не найдена",
          409: "Директория уже существует",
        }),
      },
    },
    get: {
      tags: ["directories"],
      summary: "Подкаталоги каталога",
      operationId: "listDirectories",
      requestParams: { query: directoriesQuerySchema },
      responses: {
        200: {
          description: "Подкаталоги",
          content: json(directoriesResponseSchema),
        },
        ...apiErrors({
          400: "Недопустимый каталог",
          404: "Директория не найдена",
        }),
      },
    },
  },
};

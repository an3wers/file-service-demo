import type { ZodOpenApiPathsObject } from "zod-openapi";
import { apiErrors } from "../../../../http-contract.js";
import {
  directoriesQuerySchema,
  downloadUrlQuerySchema,
  fileCardQuerySchema,
  idParamsSchema,
  listFilesQuerySchema,
  partUrlsSchema,
  presignUploadSchema,
  uploadFormSchema,
} from "./schemas.js";
import {
  directoriesResponseSchema,
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
  "/": {
    post: {
      tags: ["files"],
      summary: "Загрузить файл через сервер",
      description:
        "Файл целиком буферизуется в памяти сервера и ограничен MAX_UPLOAD_SIZE_MB. " +
        "Файлы крупнее грузятся через /presign-upload.",
      operationId: "uploadFile",
      requestBody: {
        required: true,
        content: { "multipart/form-data": { schema: uploadFormSchema } },
      },
      responses: {
        201: { description: "Файл сохранён", content: json(fileDtoSchema) },
        ...apiErrors({
          400: "Нет поля file, лишние поля формы, недопустимое имя или каталог",
          413: "Файл больше лимита загрузки через сервер",
        }),
      },
    },
    get: {
      tags: ["files"],
      summary: "Список файлов",
      operationId: "listFiles",
      requestParams: { query: listFilesQuerySchema },
      responses: {
        200: { description: "Страница списка", content: json(listFilesResponseSchema) },
        ...apiErrors({ 400: "Недопустимый каталог" }),
      },
    },
  },
  "/presign-upload": {
    post: {
      tags: ["uploads"],
      summary: "Зарезервировать файл и получить подписанные ссылки",
      description:
        "Шаг 1 загрузки в обход сервера. До порога составной загрузки — одна ссылка для PUT " +
        "(strategy = single), после — план и первая пачка ссылок на части (strategy = multipart).",
      operationId: "presignUpload",
      requestBody: { required: true, content: json(presignUploadSchema) },
      responses: {
        201: { description: "Файл зарезервирован", content: json(presignUploadResponseSchema) },
        ...apiErrors({
          400: "Недопустимое имя или каталог",
          413: "Файл больше потолка размера объекта",
          429: "Слишком много незавершённых составных загрузок",
        }),
      },
    },
  },
  "/{id}/multipart/part-urls": {
    post: {
      tags: ["uploads"],
      summary: "Следующая пачка ссылок на части",
      description: "Этим же вызовом перевыпускаются ссылки, срок которых истёк.",
      operationId: "getPartUrls",
      requestParams: { path: idParamsSchema },
      requestBody: { required: true, content: json(partUrlsSchema) },
      responses: {
        200: { description: "Ссылки на запрошенные части", content: json(partUrlsResponseSchema) },
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
        200: { description: "Загруженные части", content: json(multipartStatusResponseSchema) },
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
          description: "Карточка файла; downloadUrl есть только у готового файла при withUrl=true",
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
        200: { description: "Ссылка на скачивание", content: json(downloadUrlResponseSchema) },
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
    get: {
      tags: ["directories"],
      summary: "Подкаталоги каталога",
      operationId: "listDirectories",
      requestParams: { query: directoriesQuerySchema },
      responses: {
        200: { description: "Подкаталоги", content: json(directoriesResponseSchema) },
        ...apiErrors({ 400: "Недопустимый каталог" }),
      },
    },
  },
};

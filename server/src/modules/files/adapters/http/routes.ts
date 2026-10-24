import { createHash } from "node:crypto";
import { Router } from "express";
import type { RequestHandler, Response } from "express";
import { ERROR_CODES, badRequest, unauthorized } from "../../../../errors.js";
import { decodeOriginalName } from "./decode-original-name.js";
import {
  validateBody,
  validateParams,
  validateQuery,
  validatedParams,
  validatedQuery,
} from "../../../../middleware/validate.js";
import {
  createDirectorySchema,
  directoryPathQuerySchema,
  directoriesQuerySchema,
  downloadUrlQuerySchema,
  fileCardQuerySchema,
  idParamsSchema,
  listFilesQuerySchema,
  partUrlsSchema,
  presignUploadSchema,
  uploadBodySchema,
  resolveUploadSchema,
  updateDirectorySchema,
  updateFileSchema,
} from "./schemas.js";
import type {
  DirectoryPathQuery,
  DirectoriesQuery,
  DownloadUrlQuery,
  FileCardQuery,
  IdParams,
  ListFilesQuery,
} from "./schemas.js";
import { toFileDto } from "./dto.js";
import type { UploadsModule } from "../../application/uploads.js";
import type { CatalogModule } from "../../application/catalog.js";

export type FilesScenarios = (ownerId: string) => {
  uploads: UploadsModule;
  catalog: CatalogModule;
};

function ownerOf(res: Response): string {
  const userId: unknown = res.locals.userId;
  if (typeof userId !== "string") throw unauthorized();
  return userId;
}

export function operationIdFor(ownerId: string, id: string): string {
  const hex = createHash("sha256").update(`${ownerId}:${id}`).digest("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-8${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

export interface FilesRouterDeps {
  scenarios: FilesScenarios;
  /**
   * Парсер multipart/form-data для единственного загружаемого поля, уже несущий
   * ограничение размера, заданное в этом развёртывании.
   */
  uploadSingleFile: RequestHandler;
}

/**
 * Роуты получают уже собранные модули. Здесь ничего не знают о том, какое
 * объектное хранилище или какая база данных стоят за ними, — именно это
 * позволяет роуту оставаться про HTTP: провалидировать, вызвать один метод,
 * выбрать статус.
 */
export function createFilesRouter({
  scenarios,
  uploadSingleFile,
}: FilesRouterDeps): Router {
  const filesRouter = Router();
  const uploadsOf = (res: Response) => scenarios(ownerOf(res)).uploads;
  const catalogOf = (res: Response) => scenarios(ownerOf(res)).catalog;
  const operationOf = (res: Response, id: string) =>
    operationIdFor(ownerOf(res), id);

  // Загрузка через сервер как прокси (multipart/form-data).
  filesRouter.post(
    "/",
    uploadSingleFile,
    validateBody(uploadBodySchema),
    async (req, res) => {
      if (!req.file) {
        throw badRequest(
          ERROR_CODES.FILE_REQUIRED,
          'A file must be sent in the "file" field',
        );
      }

      const file = await uploadsOf(res).uploadThroughServer({
        operationId:
          req.body.operationId && operationOf(res, req.body.operationId),
        filename: decodeOriginalName(req.file.originalname),
        directory: req.body.directory,
        contentType: req.file.mimetype,
        bytes: req.file.buffer,
        size: req.file.size,
      });

      res.status(201).json(toFileDto(file));
    },
  );

  // Чтение сохранённого исхода операции; опрос не трогает хранилище, поэтому
  // клиент может узнать судьбу прерванной загрузки, не передавая данные заново.
  filesRouter.get(
    "/upload-operations/:id",
    validateParams(idParamsSchema),
    async (_req, res) => {
      const { id } = validatedParams<IdParams>(res);
      const result = await uploadsOf(res).getUploadOperation(
        operationOf(res, id),
      );
      res.json(
        result.status === "succeeded"
          ? { ...result, file: toFileDto(result.file) }
          : result,
      );
    },
  );

  // Сверить операцию с объектным хранилищем: после обрыва связи клиент просит
  // сервер установить фактический исход, а не угадывать его по таймауту.
  filesRouter.post(
    "/upload-operations/:id/resolve",
    validateParams(idParamsSchema),
    validateBody(resolveUploadSchema),
    async (req, res) => {
      const { id } = validatedParams<IdParams>(res);
      const result = await uploadsOf(res).resolveUploadOperation(
        operationOf(res, id),
        req.body.stoppedUploadId,
      );
      res.json(
        result.status === "succeeded"
          ? { ...result, file: toFileDto(result.file) }
          : result,
      );
    },
  );

  // Клиент знает, что загрузка не удалась: фиксируем провал и убираем остатки,
  // чтобы строка брони и занятое место в хранилище не оставались за операцией.
  filesRouter.post(
    "/upload-operations/:id/fail",
    validateParams(idParamsSchema),
    async (_req, res) => {
      const { id } = validatedParams<IdParams>(res);
      const result = await uploadsOf(res).failUploadOperation(
        operationOf(res, id),
      );
      res.json(
        result.status === "succeeded"
          ? { ...result, file: toFileDto(result.file) }
          : result,
      );
    },
  );

  // Пользователь отказался от загрузки: снимаем операцию и удаляем уже
  // принятые данные, освобождая квоту.
  filesRouter.post(
    "/upload-operations/:id/cancel",
    validateParams(idParamsSchema),
    async (_req, res) => {
      const { id } = validatedParams<IdParams>(res);
      const result = await uploadsOf(res).cancelUploadOperation(
        operationOf(res, id),
      );
      res.json(
        result.status === "succeeded"
          ? { ...result, file: toFileDto(result.file) }
          : result,
      );
    },
  );

  // Шаг 1 сценария прямой загрузки в хранилище: зарезервировать ключ и выдать
  // подписанный URL — или, если превышен порог multipart, план разбиения
  // с первой партией таких URL.
  filesRouter.post(
    "/presign-upload",
    validateBody(presignUploadSchema),
    async (req, res) => {
      const result = await uploadsOf(res).createPresignedUpload({
        operationId:
          req.body.operationId && operationOf(res, req.body.operationId),
        filename: req.body.filename,
        directory: req.body.directory,
        contentType: req.body.contentType,
        size: req.body.size,
      });
      res
        .status(201)
        .json(
          result.strategy === "ready"
            ? { ...result, file: toFileDto(result.file) }
            : result,
        );
    },
  );

  // Очередная партия URL частей, а также способ перевыпуска истёкшего.
  filesRouter.post(
    "/:id/multipart/part-urls",
    validateParams(idParamsSchema),
    validateBody(partUrlsSchema),
    async (req, res) => {
      const { id } = validatedParams<IdParams>(res);

      res.json(
        await uploadsOf(res).getPartUrls(id, {
          partNumbers: req.body.partNumbers,
        }),
      );
    },
  );

  // Что уже принято хранилищем, чтобы прерванная загрузка могла продолжиться
  // с места остановки.
  filesRouter.get(
    "/:id/multipart",
    validateParams(idParamsSchema),
    async (_req, res) => {
      const { id } = validatedParams<IdParams>(res);

      res.json(await uploadsOf(res).getMultipartStatus(id));
    },
  );

  // Страница каталога: фильтр, поиск, сортировка и пагинация считаются на
  // сервере, чтобы клиент получил список сразу с метаданными страницы.
  filesRouter.get(
    "/",
    validateQuery(listFilesQuerySchema),
    async (_req, res) => {
      const query = validatedQuery<ListFilesQuery>(res);
      const { items, total } = await catalogOf(res).listFiles(query);

      res.json({
        items: items.map((file) => toFileDto(file)),
        pagination: {
          page: query.page,
          limit: query.limit,
          total,
          totalPages: Math.ceil(total / query.limit),
        },
      });
    },
  );

  // Карточка одного файла; ссылку подписываем только по флагу withUrl, чтобы
  // не тратить её на запрос, которому нужны одни метаданные.
  filesRouter.get(
    "/:id",
    validateParams(idParamsSchema),
    validateQuery(fileCardQuerySchema),
    async (_req, res) => {
      const { id } = validatedParams<IdParams>(res);
      const { withUrl } = validatedQuery<FileCardQuery>(res);
      const { file, downloadUrl } = await catalogOf(res).getFileCard(
        id,
        withUrl,
      );

      res.json(toFileDto(file, downloadUrl));
    },
  );

  // Шаг 2 сценария прямой загрузки в хранилище: сверить с хранилищем и записать
  // фактический размер.
  // Multipart-загрузки собираются здесь же, чтобы клиент подтверждал одинаково
  // независимо от выбранной стратегии.
  filesRouter.post(
    "/:id/complete",
    validateParams(idParamsSchema),
    async (_req, res) => {
      const { id } = validatedParams<IdParams>(res);

      res.json(toFileDto(await uploadsOf(res).completeUpload(id)));
    },
  );

  // Короткоживущая подписанная ссылка: сам объект в хранилище остаётся
  // закрытым, а способ отдачи (attachment/inline) и срок выбирает клиент.
  filesRouter.get(
    "/:id/download-url",
    validateParams(idParamsSchema),
    validateQuery(downloadUrlQuerySchema),
    async (_req, res) => {
      const { id } = validatedParams<IdParams>(res);
      const { disposition, expiresIn } = validatedQuery<DownloadUrlQuery>(res);

      res.json(
        await catalogOf(res).getDownloadUrl(id, { disposition, expiresIn }),
      );
    },
  );

  filesRouter.patch(
    "/:id",
    validateParams(idParamsSchema),
    validateBody(updateFileSchema),
    async (req, res) => {
      const { id } = validatedParams<IdParams>(res);

      res.json(
        toFileDto(
          await catalogOf(res).updateFile(id, {
            name: req.body.name,
            directory: req.body.directory,
          }),
        ),
      );
    },
  );

  // Удаление файла — 204: после него возвращать нечего, а признак успеха несёт
  // сам код ответа.
  filesRouter.delete(
    "/:id",
    validateParams(idParamsSchema),
    async (_req, res) => {
      const { id } = validatedParams<IdParams>(res);

      await catalogOf(res).deleteFile(id);
      res.status(204).end();
    },
  );

  return filesRouter;
}

export function createDirectoriesRouter(scenarios: FilesScenarios): Router {
  const directoriesRouter = Router();
  const catalogOf = (res: Response) => scenarios(ownerOf(res)).catalog;

  // Подкаталоги одного уровня: нужны для навигации, поэтому отдаём только
  // детей запрошенного родителя, без рекурсии.
  directoriesRouter.get(
    "/",
    validateQuery(directoriesQuerySchema),
    async (_req, res) => {
      const { parent } = validatedQuery<DirectoriesQuery>(res);

      res.json(await catalogOf(res).listDirectories(parent));
    },
  );

  // Создание каталога внутри существующего родителя; 201, потому что появляется
  // новый ресурс со своим адресом.
  directoriesRouter.post(
    "/",
    validateBody(createDirectorySchema),
    async (req, res) => {
      res.status(201).json(
        await catalogOf(res).createDirectory({
          parent: req.body.parent,
          name: req.body.name,
        }),
      );
    },
  );

  directoriesRouter.delete(
    "/",
    validateQuery(directoryPathQuerySchema),
    async (_req, res) => {
      const { path } = validatedQuery<DirectoryPathQuery>(res);

      await catalogOf(res).deleteDirectory(path);
      res.status(204).end();
    },
  );

  directoriesRouter.patch(
    "/",
    validateQuery(directoryPathQuerySchema),
    validateBody(updateDirectorySchema),
    async (req, res) => {
      const { path } = validatedQuery<DirectoryPathQuery>(res);

      res.json(
        await catalogOf(res).moveDirectory(path, {
          name: req.body.name,
          parent: req.body.parent,
        }),
      );
    },
  );

  return directoriesRouter;
}

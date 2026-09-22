import { Router } from "express";
import type { RequestHandler } from "express";
import { ERROR_CODES, badRequest } from "../../errors.js";
import { decodeOriginalName } from "../../storage/keys.js";
import {
  validateBody,
  validateParams,
  validateQuery,
  validatedParams,
  validatedQuery,
} from "../../middleware/validate.js";
import {
  directoriesQuerySchema,
  downloadUrlQuerySchema,
  fileCardQuerySchema,
  idParamsSchema,
  listFilesQuerySchema,
  partUrlsSchema,
  presignUploadSchema,
  uploadBodySchema,
} from "./files.schemas.js";
import type {
  DirectoriesQuery,
  DownloadUrlQuery,
  FileCardQuery,
  IdParams,
  ListFilesQuery,
} from "./files.schemas.js";
import { toFileDto } from "./files.mapper.js";
import type { FilesModule } from "./files.service.js";

export interface FilesRouterDeps {
  files: FilesModule;
  /**
   * The multipart/form-data parser for the one uploaded field, already carrying
   * this deployment's size limit.
   */
  uploadSingleFile: RequestHandler;
}

/**
 * The routes get a module that is already built. Nothing here knows which
 * object store or which database is behind it, which is what keeps a route
 * about HTTP: validate, call one method, choose a status.
 */
export function createFilesRouter({ files, uploadSingleFile }: FilesRouterDeps): Router {
  const filesRouter = Router();

  // Upload proxied through the server (multipart/form-data).
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

      const file = await files.uploadThroughServer({
        filename: decodeOriginalName(req.file.originalname),
        directory: req.body.directory,
        contentType: req.file.mimetype,
        bytes: req.file.buffer,
        size: req.file.size,
      });

      res.status(201).json(toFileDto(file));
    },
  );

  // Step 1 of the direct-to-storage flow: reserve the key and hand out a signed URL —
  // or, past the multipart threshold, a split plan with the first batch of them.
  filesRouter.post("/presign-upload", validateBody(presignUploadSchema), async (req, res) => {
    res.status(201).json(
      await files.createPresignedUpload({
        filename: req.body.filename,
        directory: req.body.directory,
        contentType: req.body.contentType,
        size: req.body.size,
      }),
    );
  });

  // A further batch of part URLs, and the way an expired one gets reissued.
  filesRouter.post(
    "/:id/multipart/part-urls",
    validateParams(idParamsSchema),
    validateBody(partUrlsSchema),
    async (req, res) => {
      const { id } = validatedParams<IdParams>(res);

      res.json(await files.getPartUrls(id, { partNumbers: req.body.partNumbers }));
    },
  );

  // What storage already holds, so an interrupted upload can pick up where it
  // stopped.
  filesRouter.get("/:id/multipart", validateParams(idParamsSchema), async (_req, res) => {
    const { id } = validatedParams<IdParams>(res);

    res.json(await files.getMultipartStatus(id));
  });

  filesRouter.get("/", validateQuery(listFilesQuerySchema), async (_req, res) => {
    const query = validatedQuery<ListFilesQuery>(res);
    const { items, total } = await files.listFiles(query);

    res.json({
      items: items.map((file) => toFileDto(file)),
      pagination: {
        page: query.page,
        limit: query.limit,
        total,
        totalPages: Math.ceil(total / query.limit),
      },
    });
  });

  filesRouter.get(
    "/:id",
    validateParams(idParamsSchema),
    validateQuery(fileCardQuerySchema),
    async (_req, res) => {
      const { id } = validatedParams<IdParams>(res);
      const { withUrl } = validatedQuery<FileCardQuery>(res);
      const { file, downloadUrl } = await files.getFileCard(id, withUrl);

      res.json(toFileDto(file, downloadUrl));
    },
  );

  // Step 2 of the direct-to-storage flow: verify against storage and record the
  // real size.
  // Multipart uploads are assembled here too, so the client confirms the same way
  // whichever strategy it used.
  filesRouter.post("/:id/complete", validateParams(idParamsSchema), async (_req, res) => {
    const { id } = validatedParams<IdParams>(res);

    res.json(toFileDto(await files.completeUpload(id)));
  });

  filesRouter.get(
    "/:id/download-url",
    validateParams(idParamsSchema),
    validateQuery(downloadUrlQuerySchema),
    async (_req, res) => {
      const { id } = validatedParams<IdParams>(res);
      const { disposition, expiresIn } = validatedQuery<DownloadUrlQuery>(res);

      res.json(await files.getDownloadUrl(id, { disposition, expiresIn }));
    },
  );

  filesRouter.delete("/:id", validateParams(idParamsSchema), async (_req, res) => {
    const { id } = validatedParams<IdParams>(res);

    await files.deleteFile(id);
    res.status(204).end();
  });

  return filesRouter;
}

export function createDirectoriesRouter(files: FilesModule): Router {
  const directoriesRouter = Router();

  directoriesRouter.get("/", validateQuery(directoriesQuerySchema), async (_req, res) => {
    const { parent } = validatedQuery<DirectoriesQuery>(res);

    res.json(await files.listDirectories(parent));
  });

  return directoriesRouter;
}

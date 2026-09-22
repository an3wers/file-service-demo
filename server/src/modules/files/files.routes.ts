import { Router } from "express";
import type { RequestHandler } from "express";
import { ERROR_CODES, badRequest } from "../../errors.js";
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

      res.status(201).json(await files.uploadThroughServer(req.file, req.body.directory));
    },
  );

  // Step 1 of the direct-to-storage flow: reserve the key and hand out a signed URL —
  // or, past the multipart threshold, a split plan with the first batch of them.
  filesRouter.post("/presign-upload", validateBody(presignUploadSchema), async (req, res) => {
    res.status(201).json(await files.createPresignedUpload(req.body));
  });

  // A further batch of part URLs, and the way an expired one gets reissued.
  filesRouter.post(
    "/:id/multipart/part-urls",
    validateParams(idParamsSchema),
    validateBody(partUrlsSchema),
    async (req, res) => {
      const { id } = validatedParams<IdParams>(res);

      res.json(await files.getPartUrls(id, req.body));
    },
  );

  // What storage already holds, so an interrupted upload can pick up where it
  // stopped.
  filesRouter.get("/:id/multipart", validateParams(idParamsSchema), async (_req, res) => {
    const { id } = validatedParams<IdParams>(res);

    res.json(await files.getMultipartStatus(id));
  });

  filesRouter.get("/", validateQuery(listFilesQuerySchema), async (_req, res) => {
    res.json(await files.listFiles(validatedQuery<ListFilesQuery>(res)));
  });

  filesRouter.get(
    "/:id",
    validateParams(idParamsSchema),
    validateQuery(fileCardQuerySchema),
    async (_req, res) => {
      const { id } = validatedParams<IdParams>(res);
      const { withUrl } = validatedQuery<FileCardQuery>(res);

      res.json(await files.getFileCard(id, withUrl));
    },
  );

  // Step 2 of the direct-to-storage flow: verify against storage and record the
  // real size.
  // Multipart uploads are assembled here too, so the client confirms the same way
  // whichever strategy it used.
  filesRouter.post("/:id/complete", validateParams(idParamsSchema), async (_req, res) => {
    const { id } = validatedParams<IdParams>(res);

    res.json(await files.completeUpload(id));
  });

  filesRouter.get(
    "/:id/download-url",
    validateParams(idParamsSchema),
    validateQuery(downloadUrlQuerySchema),
    async (_req, res) => {
      const { id } = validatedParams<IdParams>(res);

      res.json(await files.getDownloadUrl(id, validatedQuery<DownloadUrlQuery>(res)));
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

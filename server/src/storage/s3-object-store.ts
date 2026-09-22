import {
  AbortMultipartUploadCommand,
  CompleteMultipartUploadCommand,
  CreateMultipartUploadCommand,
  DeleteObjectCommand,
  GetObjectCommand,
  HeadBucketCommand,
  HeadObjectCommand,
  ListMultipartUploadsCommand,
  ListPartsCommand,
  PutObjectCommand,
  UploadPartCommand,
} from "@aws-sdk/client-s3";
import type { S3Client } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { contentDisposition } from "./content-disposition.js";
import { isS3NoSuchUpload, isS3NotFound, storageError } from "./s3-errors.js";
import type {
  CompleteOutcome,
  MultipartUpload,
  ObjectStore,
  PutOptions,
  SignDownloadOptions,
  SignUploadOptions,
  StoredObject,
  UploadedPart,
} from "./object-store.js";

const MIB = 1024 * 1024;

/**
 * Hard limits of the multipart protocol itself, the same in every S3-compatible
 * store that speaks it. Not configurable, and not a deployment's policy: a plan
 * that breaks these is rejected by storage rather than by us. Vendor knowledge,
 * so it lives here rather than in the domain — the assembly clamps a
 * deployment's config with it before handing the result to the domain as
 * `PlanLimits`.
 */
export const PROTOCOL_LIMITS = {
  /** Every part except the last one. The last may be any size at all. */
  minPartSize: 5 * MIB,
  maxPartSize: 5 * 1024 * MIB,
  maxParts: 10_000,
  maxObjectSize: 5 * 1024 * 1024 * MIB,
} as const;

/**
 * The adapter that talks to S3. The bucket is fixed at construction: it is the
 * one fact every call would otherwise have to carry, and nothing in this service
 * writes to a second one.
 *
 * Object keys carry the file id (`<directory>/<uuid>.<ext>`), so a key in the
 * log context is enough to trace a failure back to its row.
 */
export function createS3ObjectStore(client: S3Client, bucket: string): ObjectStore {
  const fail = (error: unknown, operation: string, context: Record<string, unknown> = {}) =>
    storageError(error, { operation, bucket, ...context });

  /** Parts S3 cannot identify are dropped: completing with one would corrupt the object. */
  const toUploadedPart = (part: {
    PartNumber?: number | undefined;
    ETag?: string | undefined;
    Size?: number | undefined;
  }): UploadedPart | null =>
    part.PartNumber === undefined || part.ETag === undefined
      ? null
      : { partNumber: part.PartNumber, etag: part.ETag, size: part.Size ?? 0 };

  return {
    async checkAvailable(): Promise<void> {
      try {
        await client.send(new HeadBucketCommand({ Bucket: bucket }));
      } catch (error) {
        throw fail(error, "HeadBucket");
      }
    },

    async put(key, body, options: PutOptions) {
      try {
        const result = await client.send(
          new PutObjectCommand({
            Bucket: bucket,
            Key: key,
            Body: body,
            ContentType: options.contentType,
            ContentLength: options.contentLength,
          }),
        );

        return { etag: result.ETag ?? null };
      } catch (error) {
        throw fail(error, "PutObject", { key, size: options.contentLength });
      }
    },

    async head(key): Promise<StoredObject | null> {
      try {
        const result = await client.send(
          new HeadObjectCommand({ Bucket: bucket, Key: key }),
        );

        return {
          size: result.ContentLength ?? null,
          etag: result.ETag ?? null,
          contentType: result.ContentType ?? null,
        };
      } catch (error) {
        if (isS3NotFound(error)) {
          return null;
        }

        throw fail(error, "HeadObject", { key });
      }
    },

    async remove(key): Promise<void> {
      try {
        await client.send(new DeleteObjectCommand({ Bucket: bucket, Key: key }));
      } catch (error) {
        throw fail(error, "DeleteObject", { key });
      }
    },

    async signUpload(key, options: SignUploadOptions): Promise<string> {
      try {
        return await getSignedUrl(
          client,
          // The signature covers Content-Type, so the client must send it verbatim.
          new PutObjectCommand({
            Bucket: bucket,
            Key: key,
            ContentType: options.contentType,
          }),
          { expiresIn: options.expiresIn },
        );
      } catch (error) {
        throw fail(error, "PutObject(presign)", { key });
      }
    },

    async signDownload(key, options: SignDownloadOptions): Promise<string> {
      try {
        return await getSignedUrl(
          client,
          new GetObjectCommand({
            Bucket: bucket,
            Key: key,
            ResponseContentType: options.contentType,
            ResponseContentDisposition: contentDisposition(
              options.name,
              options.disposition,
            ),
          }),
          { expiresIn: options.expiresIn },
        );
      } catch (error) {
        throw fail(error, "GetObject(presign)", { key });
      }
    },

    async beginMultipart(key, options): Promise<string> {
      try {
        const created = await client.send(
          new CreateMultipartUploadCommand({
            Bucket: bucket,
            Key: key,
            ContentType: options.contentType,
          }),
        );

        if (!created.UploadId) {
          throw new Error("CreateMultipartUpload returned no UploadId");
        }

        return created.UploadId;
      } catch (error) {
        throw fail(error, "CreateMultipartUpload", { key });
      }
    },

    /**
     * Deliberately bare: only what identifies the part goes into the signature.
     * Content-Type belongs to the object and is fixed by CreateMultipartUpload;
     * anything else signed here would have to be reproduced by the browser byte
     * for byte.
     */
    async signPart(key, uploadId, partNumber, options): Promise<string> {
      try {
        return await getSignedUrl(
          client,
          new UploadPartCommand({
            Bucket: bucket,
            Key: key,
            UploadId: uploadId,
            PartNumber: partNumber,
          }),
          { expiresIn: options.expiresIn },
        );
      } catch (error) {
        throw fail(error, "UploadPart(presign)", { key, uploadId, partNumber });
      }
    },

    /**
     * Paginated on purpose: a page carries at most 1000 parts, and an upload is
     * allowed 10 000 of them.
     */
    async listParts(key, uploadId): Promise<UploadedPart[] | null> {
      const parts: UploadedPart[] = [];
      let marker: string | undefined;

      try {
        do {
          const page = await client.send(
            new ListPartsCommand({
              Bucket: bucket,
              Key: key,
              UploadId: uploadId,
              PartNumberMarker: marker,
              MaxParts: 1000,
            }),
          );

          for (const part of page.Parts ?? []) {
            const uploaded = toUploadedPart(part);

            if (uploaded) {
              parts.push(uploaded);
            }
          }

          // S3 returns parts in ascending PartNumber order and pages continue
          // that order, so the concatenation is already sorted for completion.
          marker = page.IsTruncated ? page.NextPartNumberMarker : undefined;
        } while (marker);
      } catch (error) {
        if (isS3NoSuchUpload(error)) {
          return null;
        }

        throw fail(error, "ListParts", { key, uploadId });
      }

      return parts;
    },

    async completeMultipart(key, uploadId, parts): Promise<CompleteOutcome> {
      try {
        await client.send(
          new CompleteMultipartUploadCommand({
            Bucket: bucket,
            Key: key,
            UploadId: uploadId,
            MultipartUpload: {
              // ETags go back exactly as S3 gave them, quotes included.
              Parts: parts.map((part) => ({
                PartNumber: part.partNumber,
                ETag: part.etag,
              })),
            },
          }),
        );

        return "assembled";
      } catch (error) {
        if (isS3NoSuchUpload(error)) {
          // Two confirmations raced. S3 settled it; the loser reads the winner's
          // result off the object instead of failing.
          return "gone";
        }

        throw fail(error, "CompleteMultipartUpload", { key, uploadId });
      }
    },

    async abortMultipart(key, uploadId): Promise<void> {
      try {
        await client.send(
          new AbortMultipartUploadCommand({
            Bucket: bucket,
            Key: key,
            UploadId: uploadId,
          }),
        );
      } catch (error) {
        if (isS3NoSuchUpload(error)) {
          return; // Nothing left to cancel.
        }

        throw fail(error, "AbortMultipartUpload", { key, uploadId });
      }
    },

    async listMultipartUploads(): Promise<MultipartUpload[]> {
      const uploads: MultipartUpload[] = [];
      let keyMarker: string | undefined;
      let uploadIdMarker: string | undefined;

      try {
        do {
          const page = await client.send(
            new ListMultipartUploadsCommand({
              Bucket: bucket,
              KeyMarker: keyMarker,
              UploadIdMarker: uploadIdMarker,
            }),
          );

          for (const upload of page.Uploads ?? []) {
            if (upload.Key !== undefined && upload.UploadId !== undefined) {
              uploads.push({
                key: upload.Key,
                uploadId: upload.UploadId,
                initiatedAt: upload.Initiated ?? null,
              });
            }
          }

          keyMarker = page.IsTruncated ? page.NextKeyMarker : undefined;
          uploadIdMarker = page.IsTruncated ? page.NextUploadIdMarker : undefined;
        } while (keyMarker !== undefined || uploadIdMarker !== undefined);
      } catch (error) {
        throw fail(error, "ListMultipartUploads");
      }

      return uploads;
    },
  };
}

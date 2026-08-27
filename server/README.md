# File service — server

REST API for storing files in Cloud.ru Object Storage (S3-compatible) with metadata in PostgreSQL.
A client-supplied "directory" becomes the prefix of the S3 object key, which is what gives the
service its folder structure — S3 itself has no folders.

## Running

```bash
npm install
npm run db:migrate     # create the schema (idempotent)
npm run s3:cors        # once per bucket, required for browser presigned uploads
npm run dev
```

| Script | What it does |
|---|---|
| `npm run dev` | watch-mode server |
| `npm run build` / `npm start` | compile to `dist/` and run |
| `npm run typecheck` | `tsc --noEmit` |
| `npm run db:migrate` | apply `src/db/migrations/*.sql`, tracked in `schema_migrations` |
| `npm run db:cleanup` | resolve presigned uploads that were never confirmed |
| `npm run s3:cors` | apply the bucket CORS rules for `CORS_ORIGIN` |

## Configuration

All of `.env` is validated by `src/config.ts` at boot; the process exits on anything missing.

Storage keys are Cloud.ru-specific: the S3 **access key id is `S3_TENANT_ID:KEY_ID`**, and the
bucket only resolves through the **path-style** endpoint (`forcePathStyle: true`), never
`<bucket>.s3.cloud.ru`.

| Variable | Default | Notes |
|---|---|---|
| `PORT` | `3000` | |
| `API_KEY` | — | required in `X-API-Key` on every `/api/*` route |
| `CORS_ORIGIN` | `http://localhost:5173` | comma-separated; also used by `npm run s3:cors` |
| `MAX_UPLOAD_SIZE_MB` | `50` | server-proxied uploads only |
| `PRESIGN_UPLOAD_TTL_SECONDS` | `900` | |
| `PRESIGN_DOWNLOAD_TTL_SECONDS` | `300` | |
| `PENDING_TTL_HOURS` | `24` | age at which `db:cleanup` resolves a pending row |
| `DATABASE_SSL` | `false` | |

## API

`/health` and `/health/ready` are open. Everything under `/api` requires `X-API-Key`.
Errors are always `{ "error": { "code", "message", "details"? } }`.

### Uploading

Two flows write the same kind of record and are interchangeable from the client's point of view.

**Through the server** — simple, capped at `MAX_UPLOAD_SIZE_MB`:

```
POST /api/files          multipart/form-data: file, directory?
→ 201 FileDto
```

**Direct to S3** — for anything larger; the bytes never touch the API process:

```
POST /api/files/presign-upload   { filename, directory?, contentType?, size? }
→ 201 { id, key, directory, uploadUrl, expiresAt, requiredHeaders }

PUT <uploadUrl>                  with exactly the headers in requiredHeaders
                                 (Content-Type is part of the signature)

POST /api/files/:id/complete
→ 200 FileDto
```

The `complete` call is not optional. Until it runs the row stays `pending`, and it is what fills
in `size` and `etag` — read back from S3 with `HeadObject` rather than trusted from the client.
It is idempotent, and returns `409 UPLOAD_NOT_COMPLETED` if no object reached the reserved key.

### Reading

```
GET /api/files?directory=&recursive=&search=&status=&page=&limit=&sort=&order=
→ { items: FileDto[], pagination: { page, limit, total, totalPages } }
```

`directory` matches exactly unless `recursive=true`. `status` defaults to `ready` (`any` for all),
`limit` caps at 200, `sort` is one of `created_at` | `original_name` | `size_bytes`.

```
GET /api/files/:id?withUrl=true          → FileDto (withUrl adds a fresh downloadUrl)
GET /api/files/:id/download-url?disposition=attachment|inline&expiresIn=
                                         → { url, expiresAt, name }
DELETE /api/files/:id                    → 204
GET /api/directories?parent=docs         → { parent, items: [{ name, path, fileCount }] }
```

`/api/directories` derives the folder tree from the stored directory paths; `fileCount` covers the
whole subtree. Download URLs carry a `Content-Disposition` that restores the original file name,
including non-ASCII ones, via RFC 5987 `filename*`.

### FileDto

```jsonc
{
  "id": "a5e1ee53-…",              // also the basename of the S3 key
  "name": "Отчёт за Q3.pdf",       // original name, preserved in the DB
  "directory": "docs/reports",     // normalised: no leading/trailing/repeated slashes
  "extension": "pdf",
  "contentType": "application/pdf",
  "size": 74,                      // null until a presigned upload is confirmed
  "etag": "\"9020e7b4…\"",
  "status": "ready",               // pending | ready | failed
  "uploadSource": "server",        // server | presigned
  "bucket": "bucket-4f84ee",
  "key": "docs/reports/a5e1ee53-….pdf",
  "createdAt": "2026-08-27T12:45:43.437Z",
  "updatedAt": "2026-08-27T12:45:43.437Z"
}
```

## Design notes

- **Object keys are `<directory>/<uuid>.<ext>`,** never the original file name. The key is
  therefore known before any bytes exist — which is what makes the presigned flow possible — and
  uploads can never collide or trip over characters that are awkward in a URL. The display name
  lives in the database and comes back through `Content-Disposition`.
- **Directory strings are the one untrusted input that becomes part of a key,** so
  `normalizeDirectory` in `src/s3/keys.ts` rejects `..`, control characters and oversized segments
  outright instead of rewriting them.
- **Deletes are soft in the database and best-effort in S3.** The metadata row is the source of
  truth, so it is retired first; a failed storage delete only leaves an unreferenced object.
- **`src/middleware/validate.ts`** publishes validated query strings and route params on
  `res.locals` because Express 5 makes `req.query` getter-only.

## Layout

```
src/
  config.ts logger.ts errors.ts app.ts server.ts
  db/        pool.ts, migrate.ts, migrations/
  s3/        client.ts (Cloud.ru specifics), keys.ts (naming and sanitising)
  middleware/ api-key.ts, upload.ts, validate.ts, error-handler.ts
  modules/files/  routes → service → repo, plus schemas/types/mapper
  scripts/   s3-cors.ts, cleanup-pending.ts
```

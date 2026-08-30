-- Multipart uploads reserve a key like the single presigned flow does, but the
-- upload also carries an S3-side id and a split plan until it is completed.
alter table files add column if not exists upload_id  text;
alter table files add column if not exists part_size  bigint;
alter table files add column if not exists part_count integer;

alter table files drop constraint if exists files_source_check;
alter table files add  constraint files_source_check
  check (upload_source in ('server', 'presigned', 'multipart'));

-- `upload_id` is cleared once an upload is completed or abandoned, so the
-- partial index stays the size of the active-upload queue rather than the
-- table. `countActiveMultipart` reads it directly.
create index if not exists files_upload_id_idx
  on files (upload_id) where upload_id is not null;

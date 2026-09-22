-- A live multipart upload is a row that still carries an `upload_id`. Its plan
-- is written once, when the upload is opened, and read from then on: part
-- ranges handed to the client have to match the parts already stored, so a row
-- that lost its plan cannot be recovered by recomputing one.
--
-- Rows that predate this rule are settled rather than migrated: without a plan
-- nothing can finish them, and `db:cleanup` would have marked them failed at
-- their TTL anyway.
update files
   set status = 'failed', upload_id = null, updated_at = now()
 where upload_id is not null
   and (size_bytes is null or part_size is null or part_count is null);

alter table files drop constraint if exists files_multipart_plan_check;
alter table files add  constraint files_multipart_plan_check
  check (
    upload_id is null
    or (size_bytes is not null and part_size is not null and part_count is not null)
  );

-- Составная загрузка резервирует ключ, как загрузка одним подписанным PUT,
-- и до завершения сохраняет идентификатор загрузки в S3 и план частей.
alter table files add column if not exists upload_id  text;
alter table files add column if not exists part_size  bigint;
alter table files add column if not exists part_count integer;

alter table files drop constraint if exists files_source_check;
alter table files add  constraint files_source_check
  check (upload_source in ('server', 'presigned', 'multipart'));

-- `upload_id` очищается при завершении или отмене загрузки, поэтому частичный
-- индекс содержит только активные загрузки, а не всю таблицу.
-- `countActiveMultipart` обращается к нему напрямую.
create index if not exists files_upload_id_idx
  on files (upload_id) where upload_id is not null;

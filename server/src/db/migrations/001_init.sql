create table if not exists files (
  id            uuid        primary key,
  bucket        text        not null,
  object_key    text        not null,
  directory     text        not null default '',
  original_name text        not null,
  extension     text        not null default '',
  content_type  text        not null default 'application/octet-stream',
  size_bytes    bigint,
  etag          text,
  status        text        not null default 'pending',
  upload_source text        not null,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  deleted_at    timestamptz,
  constraint files_status_check check (status in ('pending', 'ready', 'failed')),
  constraint files_source_check check (upload_source in ('server', 'presigned'))
);

create unique index if not exists files_object_key_uniq
  on files (bucket, object_key);

create index if not exists files_dir_created_idx
  on files (directory, created_at desc)
  where deleted_at is null;

create index if not exists files_status_created_idx
  on files (status, created_at);

create index if not exists files_name_lower_idx
  on files (lower(original_name));

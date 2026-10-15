create table upload_operations (
  id uuid primary key,
  file_id uuid not null unique,
  object_key text not null,
  directory text not null,
  original_name text not null,
  extension text not null,
  content_type text not null,
  size_bytes bigint not null check (size_bytes >= 0),
  created_at timestamptz not null default now()
);

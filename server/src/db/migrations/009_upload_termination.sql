create table upload_terminations (
  operation_id uuid primary key,
  reason text not null check (reason in ('cancelled', 'failed', 'deleted')),
  upload_id text,
  checked_at timestamptz
);

create index upload_terminations_check_idx on upload_terminations (checked_at nulls first);

alter table files add column attempt_started_at timestamptz;
update files set attempt_started_at = created_at;
alter table files alter column attempt_started_at set not null;
alter table files alter column attempt_started_at set default now();
alter table files add column attempt_generation uuid not null default gen_random_uuid();
create index files_pending_attempt_idx on files (attempt_started_at)
  where status = 'pending' and deleted_at is null;

alter table files
  add column live_owner_id uuid
    generated always as (case when deleted_at is null then owner_id end) stored,
  add column live_directory text
    generated always as (case when deleted_at is null then directory end) stored;

alter table files drop constraint files_directory_fk;
alter table files add constraint files_directory_fk
  foreign key (live_owner_id, live_directory) references directories (owner_id, path)
  match full not valid;

create index files_live_directory_idx on files (live_owner_id, live_directory)
  where live_directory is not null;

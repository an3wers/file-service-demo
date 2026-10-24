alter table files add column owner_id uuid references users(id);
alter table directories add column owner_id uuid references users(id);
alter table upload_operations add column owner_id uuid references users(id);

alter table files drop constraint files_directory_fk;
alter table directories drop constraint directories_parent_fkey;
alter table directories drop constraint directories_pkey;
alter table directories drop constraint directories_parent_name_uniq;
alter table directories add constraint directories_owner_path_uniq unique (owner_id, path);
alter table directories add constraint directories_parent_fk
  foreign key (owner_id, parent) references directories (owner_id, path);
alter table files add constraint files_directory_fk
  foreign key (owner_id, directory) references directories (owner_id, path) match full not valid;
alter table directories add constraint directories_owner_required check (owner_id is not null) not valid;

create index files_owner_dir_created_idx on files (owner_id, directory, created_at desc)
  where deleted_at is null;
create index upload_operations_owner_file on upload_operations (owner_id, file_id);

insert into directories (owner_id, path, parent, name) select id, '', null, '' from users;

create function create_personal_root() returns trigger language plpgsql as $$
begin
  insert into directories (owner_id, path, parent, name) values (new.id, '', null, '');
  return new;
end
$$;

create trigger users_personal_root after insert on users
  for each row execute function create_personal_root();

alter table upload_operations add constraint upload_operations_owner_required check (owner_id is not null) not valid;

create function check_upload_owner() returns trigger language plpgsql as $$
begin
  if exists (
    select 1 from upload_operations o join files f on f.id = o.file_id
     where f.owner_id is distinct from o.owner_id
       and (case when tg_table_name = 'files' then f.id else o.id end) = new.id
  ) then
    raise exception 'upload operation and file belong to different owners' using errcode = '23514';
  end if;
  return null;
end
$$;

create constraint trigger files_upload_owner after insert or update of owner_id on files
  for each row execute function check_upload_owner();
create constraint trigger upload_operations_file_owner after insert or update of owner_id, file_id on upload_operations
  for each row execute function check_upload_owner();

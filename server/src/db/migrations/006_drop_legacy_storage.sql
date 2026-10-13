do $$
begin
  if exists (
    select 1
      from pg_attribute
     where attrelid = 'files'::regclass
       and attname = 'storage'
       and not attisdropped
  ) then
    truncate files;
    delete from directories where path <> '';
    alter table files drop column storage;
    alter table files alter column bucket set not null;
    create unique index if not exists files_object_key_uniq on files (bucket, object_key);
  end if;
end
$$;

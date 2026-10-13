do $$
begin
  if exists (
    select 1
      from pg_attribute
     where attrelid = 'files'::regclass
       and attname = 'storage'
       and not attisdropped
       and not atthasdef
  ) then
    alter table files alter column storage set default 'primary';
  end if;
end
$$;

create table directories (
  path text collate "C" primary key,
  parent text collate "C" references directories(path),
  name text collate "C" not null,
  constraint directories_parent_name_uniq unique (parent, name),
  constraint directories_structure_check check (
    (path = '' and parent is null and name = '') or
    (path <> '' and parent is not null and name <> '' and
     position('/' in name) = 0 and
     path = case when parent = '' then name else parent || '/' || name end)
  )
);

insert into directories (path, parent, name) values ('', null, '');

with paths as (
  select distinct array_to_string(parts[1:depth], '/') as path,
         case when depth = 1 then '' else array_to_string(parts[1:depth - 1], '/') end as parent,
         parts[depth] as name
    from files
    cross join lateral (select string_to_array(directory, '/') as parts) segments
    cross join lateral generate_series(1, cardinality(parts)) as depth
   where directory <> ''
)
insert into directories (path, parent, name)
select path, parent, name from paths order by length(path)
on conflict (path) do nothing;

alter table files add constraint files_directory_fk foreign key (directory) references directories(path);

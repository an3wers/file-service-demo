-- Живая составная загрузка сохраняет `upload_id`. Её план записывается
-- один раз при открытии: диапазоны байтов, выданные клиенту, должны совпадать
-- с уже сохранёнными частями, поэтому потерянный план нельзя восстановить
-- повторным расчётом.
--
-- Старые строки без плана переводятся в неудавшиеся: завершить такие загрузки
-- невозможно, а `db:cleanup` всё равно пометил бы их неудавшимися
-- после истечения TTL.
update files
   set status = 'failed', upload_id = null, updated_at = now()
 where upload_id is not null
   and (size_bytes is null or part_size is null or part_count is null);

alter table files drop constraint if exists files_multipart_plan_check;
alter table files add  constraint files_multipart_plan_check
  check (
    upload_id is null
    or (size_bytes is not null and part_size is not null and part_count is not null)
  );

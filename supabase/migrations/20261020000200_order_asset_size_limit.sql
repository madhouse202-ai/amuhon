-- Keep the existing private order-file bucket aligned with the application's
-- 40,000,000-byte per-file limit. This is additive so already-applied
-- migrations and existing order records remain untouched.
do $$
declare
  bucket_is_public boolean;
begin
  select "public" into bucket_is_public
  from storage.buckets
  where id = 'amuhon-order-files'
  for update;

  if not found then
    raise exception 'Required private bucket amuhon-order-files does not exist';
  end if;
  if bucket_is_public is distinct from false then
    raise exception 'Bucket amuhon-order-files must remain private';
  end if;

  update storage.buckets
  set file_size_limit = 40000000
  where id = 'amuhon-order-files';
end;
$$;

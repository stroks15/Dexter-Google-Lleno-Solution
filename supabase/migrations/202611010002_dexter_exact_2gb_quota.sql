-- Decimal 2 GB means exactly 2,000,000,000 bytes.
create or replace function public.dexter_enforce_free_transfer_limit()
returns trigger language plpgsql set search_path=public,pg_temp as $$
begin
 if new.plan_type='free' and new.bytes_transferred>2000000000 then
  raise exception 'free_transfer_limit_exceeded' using errcode='check_violation';
 end if;
 new.updated_at=now(); return new;
end $$;
create or replace function public.dexter_add_transferred_bytes(p_user_id uuid,p_bytes bigint)
returns bigint language plpgsql security definer set search_path=public,pg_temp as $$
declare v_total bigint;
begin
 if p_bytes is null or p_bytes<0 then raise exception 'invalid_byte_count' using errcode='22023'; end if;
 insert into public.dexter_user_entitlements(user_id) values(p_user_id) on conflict(user_id) do nothing;
 update public.dexter_user_entitlements set bytes_transferred=bytes_transferred+p_bytes,updated_at=now()
 where user_id=p_user_id and (plan_type<>'free' or bytes_transferred+p_bytes<=2000000000)
 returning bytes_transferred into v_total;
 if v_total is null then raise exception 'free_transfer_limit_exceeded' using errcode='check_violation'; end if;
 return v_total;
end $$;
revoke all on function public.dexter_add_transferred_bytes(uuid,bigint) from public,anon,authenticated;
grant execute on function public.dexter_add_transferred_bytes(uuid,bigint) to service_role;

-- v1.36. Logical deletion of stopped device registrations: do not delete receipts, files or device rows.
create table if not exists sentlog_archive_private.removed_device_registrations (
  device_id uuid primary key references public.sentlog_devices(id) on delete restrict,
  owner_id uuid not null,
  removed_at timestamptz not null default now(),
  removed_by uuid not null,
  device_name text not null,
  device_type text not null,
  last_seen_at timestamptz
);
alter table sentlog_archive_private.removed_device_registrations enable row level security;
revoke all on table sentlog_archive_private.removed_device_registrations from public, anon, authenticated;
create index if not exists sentlog_removed_device_owner_idx on sentlog_archive_private.removed_device_registrations(owner_id);

create or replace function sentlog_archive_private.prevent_removed_device_reactivation()
returns trigger language plpgsql security definer set search_path='' as $$
begin
  if exists(select 1 from sentlog_archive_private.removed_device_registrations
    where device_id=old.id) then
    raise exception 'この端末登録は一覧から削除済みです。元の登録の再開・変更はできません。';
  end if;
  if tg_op='DELETE' then return old; else return new; end if;
end $$;
revoke all on function sentlog_archive_private.prevent_removed_device_reactivation() from public, anon, authenticated;
drop trigger if exists sentlog_removed_device_guard on public.sentlog_devices;
create trigger sentlog_removed_device_guard before update or delete on public.sentlog_devices
  for each row execute function sentlog_archive_private.prevent_removed_device_reactivation();

create or replace function sentlog_archive_private.device_registration_gateway(
    p_action text, p_actor uuid, p_data jsonb)
returns jsonb language plpgsql security definer set search_path='' as $$
declare uid uuid:=auth.uid(); target uuid; d public.sentlog_devices%rowtype;
begin
  if uid is null then raise exception 'ログインしてください。'; end if;
  if p_actor is null or not exists(
    select 1 from public.sentlog_devices a
    where a.id=p_actor and a.owner_id=uid and a.active
      and not exists(select 1 from sentlog_archive_private.removed_device_registrations r
                     where r.device_id=a.id)
  ) then raise exception 'この端末の有効な登録を確認してください。'; end if;
  if p_action='list' then
    return (select coalesce(jsonb_agg(r.device_id order by r.removed_at),'[]'::jsonb)
            from sentlog_archive_private.removed_device_registrations r where r.owner_id=uid);
  end if;
  if p_action<>'remove' then raise exception '未対応の端末管理操作です。'; end if;
  if coalesce((p_data->>'confirmed')::boolean,false) is not true
     or (p_data->>'confirm_device_id') is null then
    raise exception '削除対象と未送信データの確認が必要です。';
  end if;
  target:=(p_data->>'device_id')::uuid;
  if target is null or target=p_actor or (p_data->>'confirm_device_id')::uuid is distinct from target then
    raise exception '今操作している端末は削除できません。対象の登録番号を再確認してください。';
  end if;
  select * into d from public.sentlog_devices where id=target and owner_id=uid for update;
  if not found then raise exception '対象の端末登録が見つかりません。'; end if;
  if d.active then raise exception '先に対象の登録を停止してください。'; end if;
  if p_data->>'confirm_name' is distinct from d.device_name then
    raise exception '登録名が変更されています。一覧を更新して再確認してください。';
  end if;
  if exists(select 1 from sentlog_archive_private.removed_device_registrations
            where device_id=target and owner_id=uid) then
    return jsonb_build_object('removed',true,'already_removed',true);
  end if;
  insert into sentlog_archive_private.removed_device_registrations
    (device_id,owner_id,removed_by,device_name,device_type,last_seen_at)
    values(d.id,uid,p_actor,d.device_name,d.device_type,d.last_seen_at);
  insert into sentlog_archive_private.management_events
    (owner_id,actor_device_id,device_id,action,details)
    values(uid,p_actor,d.id,'device_remove_registration',
      jsonb_build_object('name',d.device_name,'type',d.device_type,
                         'last_seen_at',d.last_seen_at,
                         'preserves_receipts',true,'physical_delete',false));
  update sentlog_archive_private.jobs set state='cancelled'
    where owner_id=uid and state='checking';
  return jsonb_build_object('removed',true,'retained_for_references',true);
end $$;
revoke all on function sentlog_archive_private.device_registration_gateway(text,uuid,jsonb) from public, anon;
grant execute on function sentlog_archive_private.device_registration_gateway(text,uuid,jsonb) to authenticated;

create or replace function public.sentlog_device_registration_v1(
  p_action text,p_project_id uuid default null,p_device_id uuid default null,p_data jsonb default '{}'::jsonb)
returns jsonb language sql security invoker set search_path='' as $$
  select sentlog_archive_private.device_registration_gateway(p_action,p_device_id,p_data);
$$;
revoke all on function public.sentlog_device_registration_v1(text,uuid,uuid,jsonb) from public, anon;
grant execute on function public.sentlog_device_registration_v1(text,uuid,uuid,jsonb) to authenticated;

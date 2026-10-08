-- v1.35: reversible use-ending and registered-device management.
-- No records, files, receipts, identities or archive checkpoints are deleted.
create table if not exists sentlog_archive_private.retired_projects (
  project_id uuid primary key references public.sentlog_projects(id),
  owner_id uuid not null,
  retired_at timestamptz not null default now(),
  retired_by uuid,
  reason text not null,
  restored_at timestamptz,
  project_record jsonb not null,
  snapshot jsonb,
  asset_catalog jsonb not null
);
alter table sentlog_archive_private.retired_projects enable row level security;
revoke all on sentlog_archive_private.retired_projects from public,anon,authenticated;
create index if not exists sentlog_retired_owner_idx on sentlog_archive_private.retired_projects(owner_id);
create table if not exists sentlog_archive_private.management_events (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null,
  actor_device_id uuid,
  project_id uuid,
  device_id uuid,
  action text not null,
  details jsonb not null default '{}',
  created_at timestamptz not null default now()
);
alter table sentlog_archive_private.management_events enable row level security;
revoke all on sentlog_archive_private.management_events from public,anon,authenticated;
create index if not exists sentlog_management_events_owner_idx on sentlog_archive_private.management_events(owner_id,created_at);

-- Only the private authenticated gateway or the database administrator can call
-- this helper. It keeps a metadata snapshot, but NEVER claims a file backup exists.
create or replace function sentlog_archive_private.retire_project(pid uuid, expected_name text, actor uuid default null)
returns jsonb language plpgsql security invoker set search_path='' as $$
declare p public.sentlog_projects%rowtype; saved jsonb; assets jsonb;
begin
  select * into p from public.sentlog_projects where id=pid for update;
  if not found or p.name is distinct from expected_name then
    raise exception '案件名が変わっています。対象を確認してやり直してください。';
  end if;
  if exists(select 1 from sentlog_archive_private.retired_projects where project_id=p.id and restored_at is null) then
    return jsonb_build_object('status','archived','retired',true,'already_retired',true);
  end if;
  select to_jsonb(s) into saved from public.sentlog_project_snapshots s where s.project_id=p.id;
  select coalesce(jsonb_agg(to_jsonb(a) order by a.id),'[]') into assets from public.sentlog_assets a where a.project_id=p.id;
  insert into sentlog_archive_private.management_events(owner_id,actor_device_id,project_id,action,details)
    values(p.owner_id,actor,p.id,'project_retire',jsonb_build_object('project',to_jsonb(p),'snapshot',saved,'assets',assets,'file_backup_verified',false));
  insert into sentlog_archive_private.retired_projects(project_id,owner_id,retired_by,reason,project_record,snapshot,asset_catalog)
    values(p.id,p.owner_id,actor,'使用終了（不要）。残存データは保持。欠損ファイルの復旧は保証しない。',to_jsonb(p),saved,assets)
    on conflict(project_id) do update set retired_at=now(),retired_by=excluded.retired_by,reason=excluded.reason,
      restored_at=null,project_record=excluded.project_record,snapshot=excluded.snapshot,asset_catalog=excluded.asset_catalog;
  update sentlog_archive_private.jobs set state='cancelled' where project_id=p.id and state='checking';
  perform set_config('sentlog.archive_change',p.id::text,true);
  perform set_config('sentlog.management_change',p.id::text,true);
  if p.status='active' then
    update public.sentlog_projects set status='archived',archived_at=now(),updated_at=now() where id=p.id;
  end if;
  return jsonb_build_object('status','archived','retired',true,'file_backup_verified',false);
end $$;
revoke all on function sentlog_archive_private.retire_project(uuid,text,uuid) from public,anon,authenticated;

create or replace function sentlog_archive_private.retired_guard() returns trigger
language plpgsql security definer set search_path='' as $$
begin
  if exists(select 1 from sentlog_archive_private.retired_projects where project_id=old.id and restored_at is null) then
    if tg_op='DELETE' then raise exception '使用終了の記録は削除しません。'; end if;
    if new.status is distinct from old.status and coalesce(current_setting('sentlog.management_change',true),'')<>old.id::text then
      raise exception '使用終了の案件です。最新版の「使用中に戻す」から確認してください。';
    end if;
  end if;
  if tg_op='DELETE' then return old; else return new; end if;
end $$;
revoke all on function sentlog_archive_private.retired_guard() from public,anon,authenticated;
create trigger sentlog_retired_project_guard before update or delete on public.sentlog_projects
  for each row execute function sentlog_archive_private.retired_guard();

create or replace function sentlog_archive_private.manage(p_action text,p_project_id uuid,p_device_id uuid,p_data jsonb)
returns jsonb language plpgsql security definer set search_path='' as $$
declare uid uuid:=auth.uid(); p public.sentlog_projects%rowtype; d public.sentlog_devices%rowtype;
  result jsonb; target uuid; desired boolean; newname text;
begin
  if uid is null then raise exception 'ログインしてください。'; end if;
  if p_action='device_list' then
    select coalesce(jsonb_agg(jsonb_build_object('id',x.id,'name',x.device_name,'type',x.device_type,'active',x.active,
      'last_seen_at',x.last_seen_at,'created_at',x.created_at) order by x.active desc,x.last_seen_at desc nulls last,x.id),'[]') into result
      from public.sentlog_devices x where x.owner_id=uid;
    return result;
  end if;
  if not exists(select 1 from public.sentlog_devices where id=p_device_id and owner_id=uid) then
    raise exception 'この端末の登録を確認してください。';
  end if;
  -- Account owners may explicitly re-enable their own stopped registration.
  -- This is synchronization administration, NOT account/session revocation.
  if p_action in ('device_rename','device_stop','device_resume') then
    target:=(p_data->>'device_id')::uuid;
    select * into d from public.sentlog_devices where id=target and owner_id=uid for update;
    if not found then raise exception '対象の端末登録を確認できません。'; end if;
    if p_action='device_rename' then
      newname:=btrim(coalesce(p_data->>'name',''));
      if char_length(newname)<1 or char_length(newname)>120 then raise exception '端末名を1～120文字で入力してください。'; end if;
      update public.sentlog_devices set device_name=newname where id=d.id;
    else
      if p_action='device_stop' and coalesce((p_data->>'confirmed')::boolean,false) is not true then
        raise exception '未送信の記録を確認してから、この端末登録を停止してください。';
      end if;
      if p_action='device_stop' and target=p_device_id then raise exception '今操作している端末は、別の端末から停止してください。'; end if;
      desired:=p_action='device_resume';
      update public.sentlog_devices set active=desired where id=d.id;
      if d.active is distinct from desired then
        -- Existing checkpoints refer to the previous participant set. Start a
        -- fresh check; never fake acknowledgements or remove individual reports.
        update sentlog_archive_private.jobs set state='cancelled' where owner_id=uid and state='checking';
      end if;
    end if;
    insert into sentlog_archive_private.management_events(owner_id,actor_device_id,device_id,action,details)
      values(uid,p_device_id,d.id,p_action,jsonb_build_object('before',to_jsonb(d),'after_name',coalesce(newname,d.device_name),'after_active',coalesce(desired,d.active)));
    return jsonb_build_object('updated',true,'id',d.id);
  end if;
  if not exists(select 1 from public.sentlog_devices where id=p_device_id and owner_id=uid and active) then
    raise exception 'この端末登録は停止中です。「設定 → 登録端末」で再開してください。';
  end if;
  select * into p from public.sentlog_projects where id=p_project_id and owner_id=uid for update;
  if not found then raise exception '対象の案件を確認できません。'; end if;
  if p_action='project_retire' then
    if p_data->>'confirm_name' is distinct from p.name or coalesce((p_data->>'confirmed')::boolean,false) is not true then
      raise exception '対象案件と、欠損ファイルの復旧を保証しないことを確認してください。';
    end if;
    return sentlog_archive_private.retire_project(p.id,p.name,p_device_id);
  elsif p_action='project_resume' then
    if p_data->>'confirm_name' is distinct from p.name or coalesce((p_data->>'confirmed')::boolean,false) is not true then
      raise exception '使用再開と、不足ファイルが自動復旧されないことを確認してください。';
    end if;
    if not exists(select 1 from sentlog_archive_private.retired_projects where project_id=p.id and restored_at is null) then
      raise exception 'この案件は使用終了ではありません。案件一覧を再確認してください。';
    end if;
    perform set_config('sentlog.archive_change',p.id::text,true);
    perform set_config('sentlog.management_change',p.id::text,true);
    update sentlog_archive_private.retired_projects set restored_at=now() where project_id=p.id and restored_at is null;
    update public.sentlog_projects set status='active',archived_at=null,updated_at=now() where id=p.id;
    insert into sentlog_archive_private.management_events(owner_id,actor_device_id,project_id,action)
      values(uid,p_device_id,p.id,'project_resume');
    return jsonb_build_object('status','active','retired',false);
  end if;
  raise exception '未対応の管理操作です。';
end $$;
revoke all on function sentlog_archive_private.manage(text,uuid,uuid,jsonb) from public,anon;
grant execute on function sentlog_archive_private.manage(text,uuid,uuid,jsonb) to authenticated;
create or replace function public.sentlog_management_v1(p_action text,p_project_id uuid default null,p_device_id uuid default null,p_data jsonb default '{}')
returns jsonb language sql security invoker set search_path='' as $$
  select sentlog_archive_private.manage(p_action,p_project_id,p_device_id,p_data);
$$;
revoke all on function public.sentlog_management_v1(text,uuid,uuid,jsonb) from public,anon;
grant execute on function public.sentlog_management_v1(text,uuid,uuid,jsonb) to authenticated;

-- Preserve the tested archive protocol, decorate ONLY the shared list with a
-- separate retirement flag. The original verification/finalization is untouched.
create or replace function sentlog_archive_private.dispatch(p_action text,p_project_id uuid,p_device_id uuid,p_data jsonb)
returns jsonb language plpgsql security definer set search_path='' as $$
declare uid uuid:=auth.uid(); result jsonb;
begin
  if uid is null then raise exception 'ログインしてください。'; end if;
  result:=sentlog_archive_private.gateway(p_action,p_project_id,p_device_id,p_data);
  if p_action='list' then
    select coalesce(jsonb_agg(x.value||jsonb_build_object('retired',r.project_id is not null,'retired_at',r.retired_at) order by x.ord),'[]') into result
      from jsonb_array_elements(result) with ordinality x(value,ord)
      left join sentlog_archive_private.retired_projects r on r.project_id=(x.value->>'id')::uuid and r.owner_id=uid and r.restored_at is null;
  end if;
  return result;
end $$;
revoke all on function sentlog_archive_private.dispatch(text,uuid,uuid,jsonb) from public,anon;
grant execute on function sentlog_archive_private.dispatch(text,uuid,uuid,jsonb) to authenticated;
create or replace function public.sentlog_archive_v1(p_action text,p_project_id uuid default null,p_device_id uuid default null,p_data jsonb default '{}')
returns jsonb language sql security invoker set search_path='' as $$
  select sentlog_archive_private.dispatch(p_action,p_project_id,p_device_id,p_data);
$$;
revoke all on function public.sentlog_archive_v1(text,uuid,uuid,jsonb) from public,anon;
grant execute on function public.sentlog_archive_v1(text,uuid,uuid,jsonb) to authenticated;

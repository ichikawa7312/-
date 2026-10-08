-- Additive archive protocol. No existing projects or files are moved/deleted.
begin;
create schema if not exists sentlog_archive_private;
revoke all on schema sentlog_archive_private from public, anon;
grant usage on schema sentlog_archive_private to authenticated;

create table if not exists sentlog_archive_private.jobs (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.sentlog_projects(id),
  owner_id uuid not null,
  initiator uuid not null,
  revision bigint not null,
  payload jsonb not null,
  manifest jsonb not null,
  catalog_hash text not null,
  required_devices jsonb not null,
  reports jsonb not null default '{}',
  pc_receipt jsonb,
  pc_error text,
  state text not null default 'checking' check(state in ('checking','cancelled','archived')),
  created_at timestamptz not null default now(),
  expires_at timestamptz not null default (now()+interval '10 minutes'),
  archived_at timestamptz
);
create index if not exists sentlog_archive_jobs_project_idx on sentlog_archive_private.jobs(project_id,created_at desc);
alter table sentlog_archive_private.jobs enable row level security;
revoke all on sentlog_archive_private.jobs from public,anon,authenticated;

create or replace function sentlog_archive_private.catalog(pid uuid) returns jsonb
language plpgsql security invoker set search_path='' as $$
declare s jsonb; d jsonb; st jsonb; sh jsonb; ph jsonb; a jsonb; arr jsonb:='[]'; k text;
begin
  select payload into s from public.sentlog_project_snapshots where project_id=pid;
  if s is null or jsonb_typeof(s#>'{project,drawings}') is distinct from 'array'
     or jsonb_typeof(s->'drawings') is distinct from 'array' then
    raise exception '案件の記録が未同期です。先に同期を完了してください。';
  end if;
  for d in select value from jsonb_array_elements(s#>'{project,drawings}') loop
    select value->'state' into st from jsonb_array_elements(s->'drawings') where value#>>'{meta,id}'=d->>'id';
    if st is null or jsonb_typeof(st->'shapes') is distinct from 'array' then
      raise exception '図面の変状記録が未同期です：%',d->>'name';
    end if;
    k:='drawing:'||(d->>'id');
    select jsonb_build_object('id',x.id,'kind',x.kind,'key','background:'||(d->>'id'),
      'file_name',x.file_name,'mime_type',x.mime_type,'byte_size',x.byte_size,'sha256',lower(x.sha256),
      'storage_path',x.storage_path,'status',x.status,'pc_path',r.pc_path) into a
    from public.sentlog_assets x left join public.sentlog_pc_receipts r on r.asset_id=x.id
    where x.project_id=pid and x.client_key=k and x.kind='drawing' and x.status in ('uploaded','pc_verified','storage_deleted');
    if a is null then raise exception 'PDF・図面が未同期です：%',d->>'name'; end if;
    arr:=arr||jsonb_build_array(a);
    for sh in select value from jsonb_array_elements(st->'shapes') loop
      for ph in select value from jsonb_array_elements(coalesce(sh->'photos','[]')) loop
        k:='photo:'||(d->>'id')||':'||(ph->>'id');
        select jsonb_build_object('id',x.id,'kind',x.kind,'key',k,'file_name',x.file_name,
          'mime_type',x.mime_type,'byte_size',x.byte_size,'sha256',lower(x.sha256),
          'storage_path',x.storage_path,'status',x.status,'pc_path',r.pc_path) into a
        from public.sentlog_assets x left join public.sentlog_pc_receipts r on r.asset_id=x.id
        where x.project_id=pid and x.client_key=k and x.kind='photo' and x.status in ('uploaded','pc_verified','storage_deleted');
        if a is null then raise exception '写真が未同期です：%',ph->>'name'; end if;
        arr:=arr||jsonb_build_array(a);
      end loop;
    end loop;
  end loop;
  if (select count(*) from jsonb_array_elements(arr)) <>
     (select count(distinct value->>'key') from jsonb_array_elements(arr)) then
    raise exception '図面・写真の関連付けが重複しています。保管を中止しました。';
  end if;
  return arr;
end $$;
revoke all on function sentlog_archive_private.catalog(uuid) from public,anon,authenticated;

-- Lock the project row before writes, so a legacy client cannot race finalization.
create or replace function sentlog_archive_private.guard() returns trigger
language plpgsql security definer set search_path='' as $$
declare pid uuid; mode text; frozen boolean;
begin
  if tg_table_name='sentlog_projects' then
    if tg_op='DELETE' then
      if exists(select 1 from sentlog_archive_private.jobs where project_id=old.id) then
        raise exception '保管の記録がある案件は、この操作では削除できません。';
      end if;
      return old;
    end if;
    if new.status is distinct from old.status and
       coalesce(current_setting('sentlog.archive_change',true),'') <> old.id::text then
      raise exception '保管状態は、最新版の保管操作で変更してください。';
    end if;
    if new.id is distinct from old.id or new.owner_id is distinct from old.owner_id then
      raise exception '案件の識別情報は変更できません。';
    end if;
    if old.status='archived' and new.status='archived' and new is distinct from old then
      raise exception '保管中の案件は自動更新しません。使用中に戻して編集してください。';
    end if;
    return new;
  end if;
  pid:=case when tg_op='DELETE' then old.project_id else new.project_id end;
  if tg_op='UPDATE' and (new.project_id is distinct from old.project_id or new.owner_id is distinct from old.owner_id) then
    raise exception '案件の識別情報は変更できません。';
  end if;
  select status into mode from public.sentlog_projects where id=pid for update;
  select exists(select 1 from sentlog_archive_private.jobs where project_id=pid and state='checking' and expires_at>now()) into frozen;
  if mode='archived' or frozen then
    raise exception 'この案件は保管中、または保管確認中です。変更は端末に残しています。';
  end if;
  if tg_table_name='sentlog_project_snapshots' then
    if tg_op='UPDATE' and new.revision<>old.revision+1 then
      raise exception '別端末の変更があります。同期を再確認してください。';
    end if;
  end if;
  if tg_op='DELETE' then return old; else return new; end if;
end $$;
revoke all on function sentlog_archive_private.guard() from public,anon,authenticated;
drop trigger if exists sentlog_archive_project_guard on public.sentlog_projects;
create trigger sentlog_archive_project_guard before update or delete on public.sentlog_projects for each row execute function sentlog_archive_private.guard();
drop trigger if exists sentlog_archive_snapshot_guard on public.sentlog_project_snapshots;
create trigger sentlog_archive_snapshot_guard before insert or update or delete on public.sentlog_project_snapshots for each row execute function sentlog_archive_private.guard();
drop trigger if exists sentlog_archive_asset_guard on public.sentlog_assets;
create trigger sentlog_archive_asset_guard before insert or update or delete on public.sentlog_assets for each row execute function sentlog_archive_private.guard();

create or replace function sentlog_archive_private.gateway(p_action text,p_project_id uuid,p_device_id uuid,p_data jsonb)
returns jsonb language plpgsql security definer set search_path='' as $$
declare uid uuid:=auth.uid(); p public.sentlog_projects%rowtype; j sentlog_archive_private.jobs%rowtype;
  s public.sentlog_project_snapshots%rowtype; m jsonb; required jsonb; result jsonb; d record; ispc boolean; jid uuid;
begin
  if uid is null then raise exception 'ログインしてください。'; end if;
  if p_action='list' then
    select coalesce(jsonb_agg(jsonb_build_object('id',x.id,'client_key',x.client_key,'name',x.name,'status',x.status,
      'job_id',q.id,'checking',coalesce(q.state='checking' and q.expires_at>now(),false),
      'expires_at',q.expires_at,'archived_at',x.archived_at) order by x.created_at),'[]') into result
    from public.sentlog_projects x left join lateral
      (select * from sentlog_archive_private.jobs where project_id=x.id order by created_at desc limit 1) q on true
    where x.owner_id=uid;
    return result;
  end if;
  select device_type='pc' into ispc from public.sentlog_devices where id=p_device_id and owner_id=uid and active;
  if ispc is null then raise exception '端末登録を確認してください。'; end if;
  if p_action='pc_jobs' then
    if not ispc then raise exception 'PC自動同期から操作してください。'; end if;
    select coalesce(jsonb_agg(to_jsonb(x)),'[]') into result from
      (select * from sentlog_archive_private.jobs where owner_id=uid and state='checking' and expires_at>now() order by created_at) x;
    return result;
  end if;
  select * into p from public.sentlog_projects where id=p_project_id and owner_id=uid for update;
  if not found then raise exception '対象の案件を確認できません。'; end if;
  if p_action='begin' then
    if ispc then raise exception 'セントログの案件一覧から操作してください。'; end if;
    if p.status<>'active' then raise exception 'すでに保管中です。'; end if;
    if exists(select 1 from sentlog_archive_private.jobs where project_id=p.id and state='checking' and expires_at>now()) then
      raise exception '保管の確認はすでに進行中です。';
    end if;
    select * into s from public.sentlog_project_snapshots where project_id=p.id;
    if not found or s.revision is distinct from (p_data->>'revision')::bigint then
      raise exception '案件の同期が完了していません。先に同期を確認してください。';
    end if;
    if s.payload#>>'{project,id}' is distinct from p.client_key then
      raise exception '案件の識別情報が一致しません。';
    end if;
    m:=sentlog_archive_private.catalog(p.id);
    select coalesce(jsonb_agg(jsonb_build_object('id',id,'name',device_name,'last_seen_at',last_seen_at) order by created_at),'[]') into required
      from public.sentlog_devices where owner_id=uid and active and device_type<>'pc';
    update sentlog_archive_private.jobs set state='cancelled' where project_id=p.id and state='checking';
    insert into sentlog_archive_private.jobs(project_id,owner_id,initiator,revision,payload,manifest,catalog_hash,required_devices)
      values(p.id,uid,p_device_id,s.revision,s.payload,m,
        encode(extensions.digest(s.payload::text||m::text,'sha256'),'hex'),required) returning * into j;
    return to_jsonb(j);
  elsif p_action='reopen' then
    if ispc then raise exception '案件一覧から操作してください。'; end if;
    perform set_config('sentlog.archive_change',p.id::text,true);
    update public.sentlog_projects set status='active',archived_at=null,updated_at=now() where id=p.id;
    return jsonb_build_object('status','active');
  end if;
  jid:=(p_data->>'job_id')::uuid;
  select * into j from sentlog_archive_private.jobs where id=jid and project_id=p.id and owner_id=uid for update;
  if not found then raise exception '保管の確認番号が見つかりません。'; end if;
  if p_action='inspect' then return to_jsonb(j); end if;
  if p_action='cancel' then
    if j.state='checking' then update sentlog_archive_private.jobs set state='cancelled' where id=j.id; end if;
    return jsonb_build_object('cancelled',true);
  end if;
  if j.state<>'checking' or j.expires_at<=now() then raise exception '確認の有効時間が切れました。もう一度やり直してください。'; end if;
  if p_action='report' then
    if ispc then raise exception 'アプリ端末から確認してください。'; end if;
    if not exists(select 1 from jsonb_array_elements(j.required_devices) x where x->>'id'=p_device_id::text) then
      raise exception '新しい端末が登録されています。保管確認をやり直してください。';
    end if;
    if p_data->>'catalog_hash' is distinct from j.catalog_hash then raise exception '保管の内容が変わりました。'; end if;
    update sentlog_archive_private.jobs set reports=reports||jsonb_build_object(p_device_id::text,
      jsonb_build_object('clean',coalesce((p_data->>'clean')::boolean,false),'reason',left(coalesce(p_data->>'reason',''),500),'at',now())) where id=j.id;
    return jsonb_build_object('reported',true);
  elsif p_action='pc_error' then
    if not ispc then raise exception 'PCから操作してください。'; end if;
    update sentlog_archive_private.jobs set pc_error=left(p_data->>'reason',1000),pc_receipt=null where id=j.id;
    return jsonb_build_object('reported',true);
  elsif p_action='pc_complete' then
    if not ispc then raise exception 'PCから操作してください。'; end if;
    if p_data->>'catalog_hash' is distinct from j.catalog_hash or
       (p_data->>'file_count')::int is distinct from jsonb_array_length(j.manifest) or
       coalesce(p_data->>'package_sha256','') !~ '^[0-9a-f]{64}$' or
       coalesce(p_data->>'path','')='' then raise exception 'PCバックアップの照合が完了していません。'; end if;
    update sentlog_archive_private.jobs set pc_error=null,pc_receipt=jsonb_build_object(
      'device_id',p_device_id,'path',p_data->>'path','package_sha256',p_data->>'package_sha256',
      'file_count',p_data->'file_count','catalog_hash',j.catalog_hash,'verified_at',now()) where id=j.id;
    return jsonb_build_object('verified',true);
  elsif p_action='finalize' then
    if ispc or p_device_id<>j.initiator then raise exception '確認を開始した端末で保管を確定してください。'; end if;
    if p.status<>'active' then raise exception '案件の状態が変わりました。'; end if;
    -- New active devices must never be silently excluded from a running check.
    if exists(select 1 from public.sentlog_devices dd where dd.owner_id=uid and dd.active and dd.device_type<>'pc'
      and not exists(select 1 from jsonb_array_elements(j.required_devices) x where x->>'id'=dd.id::text)) then
      raise exception '新しい端末が登録されました。保管確認をやり直してください。'; end if;
    for d in select value as info from jsonb_array_elements(j.required_devices) loop
      if coalesce((j.reports#>>array[d.info->>'id','clean'])::boolean,false) is not true then
        raise exception '未同期または未確認の端末があります：%',d.info->>'name';
      end if;
      if (j.reports#>>array[d.info->>'id','at'])::timestamptz<now()-interval '90 seconds' then
        raise exception '端末の確認が古くなりました。すべての端末を開いて再確認してください。'; end if;
    end loop;
    if j.pc_receipt is null or (j.pc_receipt->>'verified_at')::timestamptz<now()-interval '90 seconds' then
      raise exception 'PCの最新バックアップを確認できません。PC自動同期を開いてください。'; end if;
    select * into s from public.sentlog_project_snapshots where project_id=p.id;
    if s.revision is distinct from j.revision or s.payload is distinct from j.payload then
      raise exception '案件の記録が変わりました。確認をやり直してください。'; end if;
    perform set_config('sentlog.archive_change',p.id::text,true);
    update public.sentlog_projects set status='archived',archived_at=now(),updated_at=now() where id=p.id;
    update sentlog_archive_private.jobs set state='archived',archived_at=now() where id=j.id;
    return jsonb_build_object('status','archived','backup_path',j.pc_receipt->>'path');
  end if;
  raise exception '未対応の保管操作です。';
end $$;
revoke all on function sentlog_archive_private.gateway(text,uuid,uuid,jsonb) from public,anon;
grant execute on function sentlog_archive_private.gateway(text,uuid,uuid,jsonb) to authenticated;

create or replace function public.sentlog_archive_v1(p_action text,p_project_id uuid default null,p_device_id uuid default null,p_data jsonb default '{}')
returns jsonb language sql security invoker set search_path='' as $$
  select sentlog_archive_private.gateway(p_action,p_project_id,p_device_id,p_data);
$$;
revoke all on function public.sentlog_archive_v1(text,uuid,uuid,jsonb) from public,anon;
grant execute on function public.sentlog_archive_v1(text,uuid,uuid,jsonb) to authenticated;
notify pgrst, 'reload schema';
commit;

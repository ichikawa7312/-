-- Sentlog capacity/restore protocol v1.
-- New private operation table. Never delete an existing project, local file,
-- snapshot or PC backup. User data only changes upon explicit device requests.
create table if not exists sentlog_archive_private.capacity_ops (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null,
  project_id uuid not null references public.sentlog_projects(id) on delete restrict,
  device_id uuid not null references public.sentlog_devices(id) on delete restrict,
  job_id uuid not null references sentlog_archive_private.jobs(id) on delete restrict,
  action text not null check(action in ('verify','restore')),
  mode text not null check(mode in ('files','project')),
  state text not null default 'requested' check(state in ('requested','ready','finished','cancelled')),
  pc_device_id uuid references public.sentlog_devices(id) on delete restrict,
  pc_ready_at timestamptz,
  last_error text,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null default(now()+interval '45 minutes'),
  finished_at timestamptz,
  cleaned_at timestamptz
);
create index if not exists sentlog_capacity_owner_state_idx
  on sentlog_archive_private.capacity_ops(owner_id,state,created_at desc);
alter table sentlog_archive_private.capacity_ops enable row level security;
revoke all on sentlog_archive_private.capacity_ops from public,anon,authenticated;

-- An active capacity check locks the archive lifecycle. An old client cannot
-- reopen a case mid-purge and restore its outgoing automatic sync.
create or replace function sentlog_archive_private.capacity_project_guard()
returns trigger language plpgsql security definer set search_path='' as $$
begin
  if new.status is distinct from old.status and
      exists(select 1 from sentlog_archive_private.capacity_ops x
        where x.project_id=old.id and x.state in ('requested','ready') and x.expires_at>now()) then
    raise exception 'この案件は端末の容量整理または復旧中です。完了または中止してから使用状態を変更してください。';
  end if;
  return new;
end $$;
revoke all on function sentlog_archive_private.capacity_project_guard() from public,anon,authenticated;
drop trigger if exists sentlog_capacity_project_guard on public.sentlog_projects;
create trigger sentlog_capacity_project_guard before update of status on public.sentlog_projects
  for each row execute function sentlog_archive_private.capacity_project_guard();

create or replace function sentlog_archive_private.capacity_gateway(
  p_action text,p_project_id uuid,p_device_id uuid,p_data jsonb)
returns jsonb language plpgsql security definer set search_path='' as $$
declare
  uid uuid:=auth.uid(); actor public.sentlog_devices%rowtype;
  p public.sentlog_projects%rowtype; j sentlog_archive_private.jobs%rowtype;
  x sentlog_archive_private.capacity_ops%rowtype;
  rec jsonb; paths jsonb;
  target uuid; requested_action text; requested_mode text;
begin
  if uid is null then raise exception 'ログインしてください。'; end if;
  select * into actor from public.sentlog_devices
    where id=p_device_id and owner_id=uid and active;
  if not found then raise exception '有効な端末登録を確認できません。'; end if;
  if exists(select 1 from sentlog_archive_private.removed_device_registrations r
            where r.device_id=actor.id) then
     raise exception 'この端末登録は使用終了しています。';
  end if;

  if p_action='pc_jobs' then
    if actor.device_type<>'pc' then raise exception '会社PCの自動同期画面から操作してください。'; end if;
    select coalesce(jsonb_agg(
      jsonb_build_object('operation',to_jsonb(o),
        'job',jsonb_build_object('id',jj.id,'project_id',jj.project_id,'revision',jj.revision,
          'payload',jj.payload,'manifest',jj.manifest,
          'catalog_hash',jj.catalog_hash,'pc_receipt',jj.pc_receipt))
      order by o.created_at),'[]'::jsonb) into rec
    from sentlog_archive_private.capacity_ops o
      join sentlog_archive_private.jobs jj on jj.id=o.job_id
    where o.owner_id=uid and o.state='requested' and o.expires_at>now();
    return rec;
  end if;

  if p_action='pc_cleanup' then
    if actor.device_type<>'pc' then raise exception '会社PCから操作してください。';end if;
    select coalesce(jsonb_agg(jsonb_build_object('id',o.id,
      'owner_id',o.owner_id,'manifest',jj.manifest,'action',o.action) order by o.created_at),
      '[]'::jsonb) into rec
    from sentlog_archive_private.capacity_ops o
      join sentlog_archive_private.jobs jj on jj.id=o.job_id
    where o.owner_id=uid and o.action='restore' and
      (o.state in ('finished','cancelled') or o.expires_at<now()-interval '1 hour')
      and o.cleaned_at is null;
    return rec;
  end if;

  if p_action='begin' then
    if actor.device_type='pc' then raise exception 'セントログ本体の保管フォルダから操作してください。';end if;
    if p_project_id is null then raise exception '案件を選択してください。';end if;
    select * into p from public.sentlog_projects where id=p_project_id and owner_id=uid for update;
    if not found or p.status<>'archived' then raise exception '通常の「保管」が完了した案件のみ対応します。';end if;
    if exists(select 1 from sentlog_archive_private.retired_projects r
      where r.project_id=p.id and r.restored_at is null) then
      raise exception '「使用終了（不要）」はPCへの完全な保管が確認されていないため、容量整理・復旧はできません。';
    end if;
    select * into j from sentlog_archive_private.jobs
      where project_id=p.id and owner_id=uid and state='archived'
        and pc_receipt is not null
      order by archived_at desc limit 1;
    if not found then raise exception 'PCに照合済みの案件一式がありません。容量は変更しません。';end if;
    if not exists(select 1 from public.sentlog_project_snapshots s
      where s.project_id=p.id and s.revision=j.revision and s.payload=j.payload) then
      raise exception '保管済みの案件情報が変わっています。容量は変更しません。';end if;
    requested_action:=p_data->>'action';requested_mode:=p_data->>'mode';
    if requested_action not in ('verify','restore') or requested_mode not in ('files','project') then
      raise exception '容量整理の操作を確認できません。';
    end if;
    select * into x from sentlog_archive_private.capacity_ops
      where owner_id=uid and project_id=p.id and device_id=p_device_id
        and state in ('requested','ready') and expires_at>now()
      order by created_at desc limit 1 for update;
    if found then
      if x.action=requested_action and x.mode=requested_mode then
        return jsonb_build_object('id',x.id,'reused',true,'state',x.state);
      end if;
      raise exception 'この端末で別の容量処理が進行中です。中止してから操作してください。';
    end if;
    insert into sentlog_archive_private.capacity_ops(owner_id,project_id,device_id,job_id,action,mode)
      values(uid,p.id,p_device_id,j.id,requested_action,requested_mode) returning * into x;
    return jsonb_build_object('id',x.id,'reused',false,'state',x.state);
  end if;

  if p_action in ('inspect','pc_ready','pc_error','finish','cancel','pc_cleaned') then
    target:=(p_data->>'operation_id')::uuid;
    select * into x from sentlog_archive_private.capacity_ops
      where id=target and owner_id=uid for update;
    if not found then raise exception '容量整理の確認番号が見つかりません。'; end if;
    if p_project_id is not null and p_project_id<>x.project_id then
      raise exception '対象の案件が一致しません。';
    end if;
    select * into j from sentlog_archive_private.jobs where id=x.job_id and owner_id=uid;
    if not found then raise exception '保管の控えが見つかりません。';end if;
    if p_action='inspect' then
      if x.device_id<>actor.id and actor.device_type<>'pc' then
        raise exception 'この端末の処理ではありません。';
      end if;
      select coalesce(jsonb_agg(
        f.value || jsonb_build_object('temp_path',
          x.owner_id::text||'/archive-restore/'||x.id::text||'/'||(f.value->>'id'))
        order by f.ordinality),'[]'::jsonb) into paths
        from jsonb_array_elements(j.manifest) with ordinality f(value,ordinality);
      return jsonb_build_object('operation',to_jsonb(x),'job',
          jsonb_build_object('id',j.id,'project_id',j.project_id,
            'payload',j.payload,'manifest',j.manifest,'revision',j.revision,
            'catalog_hash',j.catalog_hash,'pc_receipt',j.pc_receipt),
          'files',paths);
    end if;
    if p_action='cancel' then
      if x.device_id<>actor.id then raise exception 'この端末の処理ではありません。';end if;
      if x.state in ('requested','ready') then
        update sentlog_archive_private.capacity_ops set state='cancelled'
          where id=x.id;
      end if;
      return jsonb_build_object('cancelled',true);
    end if;
    if p_action='pc_error' then
      if actor.device_type<>'pc' then raise exception '会社PCから操作してください。';end if;
      if x.state='requested' and x.expires_at>now() then
        update sentlog_archive_private.capacity_ops set last_error=left(coalesce(p_data->>'reason',''),700)
          where id=x.id;
      end if;
      return jsonb_build_object('recorded',true);
    end if;
    if p_action='pc_cleaned' then
      if actor.device_type<>'pc' then raise exception '会社PCから操作してください。';end if;
      if x.state not in ('finished','cancelled') and x.expires_at>now() then
        raise exception '受信端末の完了または期限切れを確認してください。';
      end if;
      update sentlog_archive_private.capacity_ops set cleaned_at=now() where id=x.id;
      return jsonb_build_object('recorded',true);
    end if;
    if x.state not in ('requested','ready') or x.expires_at<=now() then
      raise exception '処理の期限が切れました。再度お試しください。';
    end if;
    if p_action='pc_ready' then
      if not exists (select 1 from public.sentlog_projects pp
        where pp.id=x.project_id and pp.status='archived' and
          not exists(select 1 from sentlog_archive_private.retired_projects r
            where r.project_id=pp.id and r.restored_at is null)) then
        raise exception '案件の保管状態が変更されたため、安全確認をやり直してください。';
      end if;
      if actor.device_type<>'pc' then raise exception '会社PCから操作してください。';end if;
      if p_data->>'catalog_hash' is distinct from j.catalog_hash
        or p_data->>'package_sha256' is distinct from j.pc_receipt->>'package_sha256'
        or (p_data->>'file_count')::int is distinct from jsonb_array_length(j.manifest) then
        raise exception 'PCの案件一式を正しく照合できません。';
      end if;
      update sentlog_archive_private.capacity_ops
        set pc_device_id=actor.id,pc_ready_at=now(),state='ready',last_error=null
        where id=x.id;
      return jsonb_build_object('ready',true);
    end if;
    if p_action='finish' then
      if x.device_id<>actor.id then raise exception 'この端末の処理ではありません。';end if;
      if x.state<>'ready' or x.pc_ready_at is null then
        raise exception '会社PCへの確認が完了していません。';
      end if;
      update sentlog_archive_private.capacity_ops set state='finished',finished_at=now() where id=x.id;
      return jsonb_build_object('finished',true);
    end if;
  end if;
  raise exception '未対応の容量管理操作です。';
end $$;

-- Archive transfer and a terminal "use-ended" operation are mutually exclusive.
create or replace function sentlog_archive_private.capacity_retirement_guard()
returns trigger language plpgsql security definer set search_path='' as $$
begin
  if tg_op='INSERT' or new.restored_at is null and
     (old.restored_at is distinct from new.restored_at) then
    if exists(select 1 from sentlog_archive_private.capacity_ops x
      where x.project_id=new.project_id and x.state in ('requested','ready') and x.expires_at>now()) then
      raise exception 'この案件は端末の容量整理または復旧中です。完了か中止後に使用終了にしてください。';
    end if;
  end if;
  return new;
end $$;
revoke all on function sentlog_archive_private.capacity_retirement_guard() from public,anon,authenticated;
drop trigger if exists sentlog_capacity_retirement_guard on sentlog_archive_private.retired_projects;
create trigger sentlog_capacity_retirement_guard before insert or update on sentlog_archive_private.retired_projects
  for each row execute function sentlog_archive_private.capacity_retirement_guard();
revoke all on function sentlog_archive_private.capacity_gateway(text,uuid,uuid,jsonb) from public,anon;
grant execute on function sentlog_archive_private.capacity_gateway(text,uuid,uuid,jsonb) to authenticated;

create or replace function public.sentlog_capacity_v1(
  p_action text,p_project_id uuid default null,p_device_id uuid default null,p_data jsonb default '{}'::jsonb)
returns jsonb language sql security invoker set search_path='' as $$
  select sentlog_archive_private.capacity_gateway(p_action,p_project_id,p_device_id,p_data);
$$;
revoke all on function public.sentlog_capacity_v1(text,uuid,uuid,jsonb) from public,anon;
grant execute on function public.sentlog_capacity_v1(text,uuid,uuid,jsonb) to authenticated;

-- Additive protocol. No business record or storage object is migrated/deleted.
-- The existing archive guard remains the authority for revision CAS/lifecycle.
create schema if not exists sentlog_collaboration_private;
revoke all on schema sentlog_collaboration_private from public, anon, authenticated;

create or replace function sentlog_collaboration_private.guard_snapshot()
returns trigger language plpgsql security invoker set search_path = '' as $fn$
declare
  headers jsonb;
  item jsonb;
  previous jsonb;
  candidate jsonb;
  entry_kind text;
  entry_key text;
  entry_value jsonb;
  candidate_entry jsonb;
  certified_delta_write boolean := false;
  revision_value jsonb;
  field_key text;
  field_value jsonb;
  revision_count bigint;
  distinct_count bigint;
  old_records jsonb := '[]'::jsonb;
  new_records jsonb := '[]'::jsonb;
  new_by_id jsonb := '{}'::jsonb;
  -- Keep this boundary identical to record-collaboration.js rawFields().
  geometry_keys constant text[] := array['kind','recordKind','recordType','memoType','page','point','points','x','y','w','h','width','height','angle','rotation','radius','rx','ry','unit'];
  ignored_field_keys constant text[] := array['id','memo','photos','collab','globalNo','typeNo','autoLabel','recordNo','labelPosEditedAt'];
begin
  -- Delta checkpoints are generated from the accepted server revision graph.
  -- Their authority is an exact, private, transaction-scoped table row; caller
  -- headers or user-settable GUCs never grant this exemption. The optional
  -- dynamic lookup leaves legacy-only installations unchanged.
  if tg_op <> 'DELETE' and to_regprocedure('sentlog_delta_private.checkpoint_authorizes_snapshot(uuid,uuid,bigint,jsonb,uuid)') is not null then
    execute 'select sentlog_delta_private.checkpoint_authorizes_snapshot($1,$2,$3,$4,$5)'
      into certified_delta_write using new.project_id,new.owner_id,new.revision,new.payload,new.updated_by_device;
    if certified_delta_write then return new; end if;
  end if;
  if tg_op = 'DELETE' then
    if old.payload #> '{project,collaborationVersion}' = '1'::jsonb then
      raise exception 'COLLAB_HISTORY_REQUIRED: 共同編集の履歴を残す削除操作を使ってください。';
    end if;
    return old;
  end if;
  if tg_op = 'UPDATE' and old.payload #> '{project,collaborationVersion}' = '1'::jsonb and
     new.payload #> '{project,collaborationVersion}' is distinct from '1'::jsonb then
    raise exception 'COLLAB_UPGRADE_REQUIRED: この案件は共同編集中です。最新版のセントログへ更新してください。端末の記録は残っています。';
  end if;
  if new.payload #> '{project,collaborationVersion}' is distinct from '1'::jsonb then return new; end if;
  headers := coalesce(nullif(current_setting('request.headers', true), ''), '{}')::jsonb;
  if headers ->> 'x-client-info' is distinct from 'sentlog-collaboration/1' then
    raise exception 'COLLAB_UPGRADE_REQUIRED: この案件は共同編集中です。最新版のセントログへ更新してください。端末の記録は残っています。';
  end if;
  if auth.uid() is null or auth.uid() is distinct from new.owner_id then
    raise exception 'COLLAB_DEVICE_REQUIRED: ログインと案件の所有者を確認してください。';
  end if;
  if not exists(select 1 from public.sentlog_devices d where d.id = new.updated_by_device and d.owner_id = new.owner_id and d.active) then
    raise exception 'COLLAB_DEVICE_REQUIRED: この端末の有効な登録を確認してください。';
  end if;
  if not exists(select 1 from public.sentlog_projects p where p.id = new.project_id and p.owner_id = new.owner_id and p.client_key = new.payload #>> '{project,id}') then
    raise exception 'COLLAB_HISTORY_REQUIRED: 保存先の案件が一致していません。端末の記録を保護しました。';
  end if;
  if jsonb_typeof(new.payload -> 'drawings') is distinct from 'array' or
     jsonb_typeof(new.payload #> '{project,drawings}') is distinct from 'array' then
    raise exception 'COLLAB_HISTORY_REQUIRED: 図面の保存一覧を確認できません。';
  end if;
  for item in select value from jsonb_array_elements(new.payload -> 'drawings') loop
    if jsonb_typeof(item #> '{meta,id}') is distinct from 'string' or
       coalesce(length(item #>> '{meta,id}'),0) not between 1 and 512 or
       coalesce(jsonb_typeof(item #> '{state,shapes}'),'null') not in ('array','null') or
       coalesce(jsonb_typeof(item #> '{state,collabDeletedRecords}'),'null') not in ('array','null') then
      raise exception 'COLLAB_HISTORY_REQUIRED: 図面または記録の識別情報を確認できません。';
    end if;
  end loop;
  if exists(select 1 from jsonb_array_elements(new.payload -> 'drawings') d
            group by d.value #>> '{meta,id}' having count(*) > 1) then
    raise exception 'COLLAB_HISTORY_REQUIRED: 同じ図面が重複しています。';
  end if;
  if exists(select 1 from jsonb_array_elements(new.payload #> '{project,drawings}') d
            group by d.value ->> 'id' having count(*) > 1) or
     (select coalesce(jsonb_agg(d.value -> 'id' order by d.value ->> 'id'),'[]'::jsonb)
      from jsonb_array_elements(new.payload #> '{project,drawings}') d) is distinct from
     (select coalesce(jsonb_agg(d.value #> '{meta,id}' order by d.value #>> '{meta,id}'),'[]'::jsonb)
      from jsonb_array_elements(new.payload -> 'drawings') d) then
    raise exception 'COLLAB_HISTORY_REQUIRED: 案件の図面一覧と保存データが一致しません。';
  end if;
  select coalesce(jsonb_agg(jsonb_build_object('drawingId',d.value #>> '{meta,id}','record',r.value)), '[]'::jsonb) into new_records
  from jsonb_array_elements(new.payload -> 'drawings') d
  cross join lateral jsonb_array_elements(coalesce(nullif(d.value #> '{state,shapes}','null'::jsonb), '[]'::jsonb) ||
                                         coalesce(nullif(d.value #> '{state,collabDeletedRecords}','null'::jsonb), '[]'::jsonb)) r;
  for item in select value -> 'record' from jsonb_array_elements(new_records) loop
    if jsonb_typeof(item) is distinct from 'object' or jsonb_typeof(item -> 'id') is distinct from 'string' or
       coalesce(length(item ->> 'id'),0) not between 1 and 512 then
      raise exception 'COLLAB_HISTORY_REQUIRED: 記録の識別情報を確認できません。';
    end if;
  end loop;
  if exists(select 1 from jsonb_array_elements(new_records) r
            group by r.value ->> 'drawingId', r.value #>> '{record,id}' having count(*) > 1) then
    raise exception 'COLLAB_HISTORY_REQUIRED: 同じ図面内で記録が重複しています。';
  end if;
  -- A record ID belongs to its drawing. The JSON array key cannot collide when
  -- IDs contain punctuation; a same-ID record in another drawing is independent.
  select coalesce(jsonb_object_agg(jsonb_build_array(r.value ->> 'drawingId',r.value #>> '{record,id}')::text,
                                  r.value -> 'record'), '{}'::jsonb) into new_by_id
  from jsonb_array_elements(new_records) r;
  for item in select value -> 'record' from jsonb_array_elements(new_records) loop
    if item #> '{collab,version}' is distinct from '1'::jsonb or
       jsonb_typeof(item #> '{collab,comments}') is distinct from 'object' or
       jsonb_typeof(item #> '{collab,fields}') is distinct from 'object' or
       jsonb_typeof(item #> '{collab,photos}') is distinct from 'object' or
       jsonb_typeof(item #> '{collab,deletion}') is distinct from 'object' then
      raise exception 'COLLAB_HISTORY_REQUIRED: 記録の共同編集履歴が不足しています。送信を止め、端末の記録を保護しました。';
    end if;
    for entry_kind,entry_key,entry_value in
      select 'comment',e.key,e.value from jsonb_each(item #> '{collab,comments}') e
      union all select 'field',e.key,e.value from jsonb_each(item #> '{collab,fields}') e
      union all select 'photo',e.key,e.value from jsonb_each(item #> '{collab,photos}') e
      union all select 'deletion','record',item #> '{collab,deletion}'
    loop
      if length(entry_key) not between 1 and 512 or jsonb_typeof(entry_value) is distinct from 'object' or
         jsonb_typeof(entry_value -> 'revisions') is distinct from 'array' then
        raise exception 'COLLAB_HISTORY_REQUIRED: 変更履歴の形式を確認できません。';
      end if;
      if jsonb_array_length(entry_value -> 'revisions') = 0 then
        raise exception 'COLLAB_HISTORY_REQUIRED: 空の変更履歴は保存できません。';
      end if;
      if entry_kind = 'comment' then
        if jsonb_typeof(entry_value -> 'order') is distinct from 'number' then
          raise exception 'COLLAB_HISTORY_REQUIRED: コメントの順序が不足しています。';
        end if;
        if (entry_value ->> 'order')::numeric < 0 or (entry_value ->> 'order')::numeric > 9007199254740991 or
           trunc((entry_value ->> 'order')::numeric) <> (entry_value ->> 'order')::numeric then
          raise exception 'COLLAB_HISTORY_REQUIRED: コメントの順序が不正です。';
        end if;
      end if;
      if entry_kind = 'field' and entry_key = any(geometry_keys || ignored_field_keys) then
        raise exception 'COLLAB_HISTORY_REQUIRED: 項目名が共同編集の管理情報と重なっています。';
      end if;
      for revision_value in select value from jsonb_array_elements(entry_value -> 'revisions') loop
        if jsonb_typeof(revision_value) is distinct from 'object' or
           jsonb_typeof(revision_value -> 'id') is distinct from 'string' or
           coalesce(length(revision_value ->> 'id'),0) not between 1 and 512 or
           jsonb_typeof(revision_value -> 'parents') is distinct from 'array' or
           jsonb_typeof(revision_value -> 'actor') is distinct from 'object' or
           jsonb_typeof(revision_value #> '{actor,deviceName}') is distinct from 'string' or
           coalesce(jsonb_typeof(revision_value #> '{actor,deviceId}'),'missing') not in ('string','null') or
           jsonb_typeof(revision_value -> 'at') is distinct from 'number' then
          raise exception 'COLLAB_HISTORY_REQUIRED: 変更番号・変更元・時刻を確認できません。';
        end if;
        if (revision_value ->> 'at')::numeric < 0 then
          raise exception 'COLLAB_HISTORY_REQUIRED: 変更時刻が不正です。';
        end if;
        if exists(select 1 from jsonb_array_elements(revision_value -> 'parents') p
                  where jsonb_typeof(p.value) is distinct from 'string' or length(p.value #>> '{}') not between 1 and 512 or
                    not exists(select 1 from jsonb_array_elements(entry_value -> 'revisions') r where r.value -> 'id' = p.value)) or
           (select count(*) <> count(distinct value) from jsonb_array_elements(revision_value -> 'parents')) then
          raise exception 'COLLAB_HISTORY_REQUIRED: 変更前の履歴が不足または重複しています。';
        end if;
        if entry_kind = 'comment' and (jsonb_typeof(revision_value -> 'text') is distinct from 'string' or
                                      jsonb_typeof(revision_value -> 'deleted') is distinct from 'boolean') then
          raise exception 'COLLAB_HISTORY_REQUIRED: コメント履歴の形式が不正です。';
        end if;
        if entry_kind = 'field' and revision_value -> 'unset' is distinct from 'true'::jsonb and not (revision_value ? 'value') then
          raise exception 'COLLAB_HISTORY_REQUIRED: 項目の値がありません。';
        end if;
        if entry_kind = 'field' and entry_key = 'geometry' and revision_value -> 'unset' is distinct from 'true'::jsonb then
          if jsonb_typeof(revision_value -> 'value') is distinct from 'object' then
            raise exception 'COLLAB_HISTORY_REQUIRED: 記録の位置・形状が不正です。';
          end if;
          if exists(select 1 from jsonb_object_keys(revision_value -> 'value') k where not (k = any(geometry_keys))) then
            raise exception 'COLLAB_HISTORY_REQUIRED: 記録の位置・形状の項目が不正です。';
          end if;
        end if;
        if entry_kind = 'photo' and (jsonb_typeof(revision_value -> 'value') is distinct from 'object' or
             revision_value #> '{value,id}' is distinct from to_jsonb(entry_key) or
             jsonb_typeof(revision_value -> 'deleted') is distinct from 'boolean') then
          raise exception 'COLLAB_HISTORY_REQUIRED: 写真履歴の識別情報が不正です。';
        end if;
        if entry_kind = 'deletion' then
          if jsonb_typeof(revision_value -> 'deleted') is distinct from 'boolean' or
             jsonb_typeof(revision_value -> 'observed') is distinct from 'array' then
            raise exception 'COLLAB_HISTORY_REQUIRED: 削除確認の履歴が不正です。';
          end if;
          if exists(select 1 from jsonb_array_elements(revision_value -> 'observed') p
                    where jsonb_typeof(p.value) is distinct from 'string' or length(p.value #>> '{}') not between 1 and 512) then
            raise exception 'COLLAB_HISTORY_REQUIRED: 削除確認の変更番号が不正です。';
          end if;
        end if;
      end loop;
      -- New revisions cannot poison a record with a parent cycle. UNION removes
      -- visited pairs, so this check terminates even for a malformed cycle.
      if exists(
        with recursive edges as (
          select r.value ->> 'id' as child,p.value #>> '{}' as parent
          from jsonb_array_elements(entry_value -> 'revisions') r
          cross join lateral jsonb_array_elements(r.value -> 'parents') p
        ), reach(child,parent) as (
          select child,parent from edges
          union select r.child,e.parent from reach r join edges e on e.child = r.parent
        ) select 1 from reach where child = parent
      ) then raise exception 'COLLAB_HISTORY_REQUIRED: 変更履歴が循環しています。'; end if;
    end loop;
    with entries as (
      select e.value from jsonb_each(item #> '{collab,comments}') e
      union all select e.value from jsonb_each(item #> '{collab,fields}') e
      union all select e.value from jsonb_each(item #> '{collab,photos}') e
      union all select item #> '{collab,deletion}'
    ), revisions as (
      select r.value from entries e cross join lateral jsonb_array_elements(e.value -> 'revisions') r
    ) select count(*), count(distinct value ->> 'id') into revision_count, distinct_count from revisions;
    if revision_count = 0 or revision_count <> distinct_count then
      raise exception 'COLLAB_HISTORY_REQUIRED: 変更番号が不足または重複しています。送信を止めました。';
    end if;
  end loop;
  -- Metadata alternatives may change a filename, but one physical drawing/photo
  -- key cannot describe contradictory known bytes. Missing legacy metadata may
  -- be enriched; all previously known metadata remains in immutable revisions.
  if exists(
    with photo_values as (
      select r.value ->> 'drawingId' as drawing_id,e.key as photo_id,p.value -> 'value' as metadata
      from jsonb_array_elements(new_records) r
      cross join lateral jsonb_each(r.value #> '{record,collab,photos}') e
      cross join lateral jsonb_array_elements(e.value -> 'revisions') p
    ) select 1 from photo_values group by drawing_id,photo_id having
      count(distinct lower(nullif(metadata ->> 'sha256',''))) > 1 or
      count(distinct lower(nullif(metadata ->> 'type',''))) > 1 or
      count(distinct case when metadata ->> 'size' ~ '^[0-9]+$'
                          then nullif((metadata ->> 'size')::numeric,0) end) > 1
  ) then raise exception 'COLLAB_HISTORY_REQUIRED: 同じ写真IDの原本情報が一致しません。上書きせず端末に保持しています。'; end if;
  if tg_op = 'UPDATE' then
    select coalesce(jsonb_agg(jsonb_build_object('drawingId',d.value #>> '{meta,id}','record',r.value)), '[]'::jsonb) into old_records
    from jsonb_array_elements(old.payload -> 'drawings') d
    cross join lateral jsonb_array_elements(coalesce(nullif(d.value #> '{state,shapes}','null'::jsonb), '[]'::jsonb) ||
                                           coalesce(nullif(d.value #> '{state,collabDeletedRecords}','null'::jsonb), '[]'::jsonb)) r;
    for item in select value from jsonb_array_elements(old_records) loop
      previous := item -> 'record';
      candidate := new_by_id -> (jsonb_build_array(item ->> 'drawingId',previous ->> 'id')::text);
      if candidate is null then
        raise exception 'COLLAB_HISTORY_REQUIRED: 元の図面に記録の履歴を残してください。最新の記録を受信してから再送してください。';
      end if;
      if previous #> '{collab,version}' = '1'::jsonb then
        if not (((candidate -> 'collab') - 'projection') @> ((previous -> 'collab') - 'projection')) then
          raise exception 'COLLAB_HISTORY_REQUIRED: 別の端末の変更履歴が不足しています。最新の記録を受信してから再送してください。';
        end if;
        -- JSONB containment alone permits adding parents/observed to an old
        -- revision. Compare each revision exactly, independent of array order.
        for entry_kind,entry_key,entry_value in
          select 'comments',e.key,e.value from jsonb_each(previous #> '{collab,comments}') e
          union all select 'fields',e.key,e.value from jsonb_each(previous #> '{collab,fields}') e
          union all select 'photos',e.key,e.value from jsonb_each(previous #> '{collab,photos}') e
          union all select 'deletion','record',previous #> '{collab,deletion}'
        loop
          candidate_entry := case when entry_kind = 'deletion' then candidate #> '{collab,deletion}'
                                  else candidate #> array['collab',entry_kind,entry_key] end;
          if (candidate_entry - 'revisions') is distinct from (entry_value - 'revisions') then
            raise exception 'COLLAB_HISTORY_REQUIRED: 保存済みの項目情報が書き換えられています。';
          end if;
          for revision_value in select value from jsonb_array_elements(entry_value -> 'revisions') loop
            if not exists(select 1 from jsonb_array_elements(candidate_entry -> 'revisions') r
                          where r.value -> 'id' = revision_value -> 'id' and r.value = revision_value) then
              raise exception 'COLLAB_HISTORY_REQUIRED: 保存済みの変更履歴が書き換えられています。';
            end if;
          end loop;
        end loop;
      else
        -- The first upgrade retains every legacy value as a complete revision,
        -- including explicit deletion and edits made during the first sync.
        if coalesce(previous ->> 'memo', '') <> '' and not exists (
          select 1 from jsonb_each(candidate #> '{collab,comments}') e
          cross join lateral jsonb_array_elements(e.value -> 'revisions') r
          where r.value ->> 'text' = previous ->> 'memo'
        ) then raise exception 'COLLAB_HISTORY_REQUIRED: 既存コメントの履歴を保護しました。最新の記録を受信してください。'; end if;
        for field_key,field_value in
          select 'geometry',coalesce(jsonb_object_agg(e.key,e.value),'{}'::jsonb)
            from jsonb_each(previous) e where e.key = any(geometry_keys)
          union all
          select e.key,e.value from jsonb_each(previous) e where not (e.key = any(geometry_keys || ignored_field_keys))
        loop
          if not exists(select 1 from jsonb_array_elements(candidate #> array['collab','fields',field_key,'revisions']) r
                        where r.value -> 'unset' is distinct from 'true'::jsonb and r.value -> 'value' = field_value) then
            raise exception 'COLLAB_HISTORY_REQUIRED: 既存の位置・項目の値を履歴に残してください。';
          end if;
        end loop;
        for revision_value in select value from jsonb_array_elements(coalesce(previous -> 'photos', '[]'::jsonb)) loop
          if not exists (
            select 1 from jsonb_array_elements(candidate #> array['collab','photos',revision_value ->> 'id','revisions']) r
            where r.value -> 'value' = (revision_value - 'localBlob' - 'data')
          ) then raise exception 'COLLAB_HISTORY_REQUIRED: 既存写真の原本情報と関連付けを保護しました。最新の記録を受信してください。'; end if;
        end loop;
      end if;
    end loop;
  end if;
  return new;
end $fn$;
revoke all on function sentlog_collaboration_private.guard_snapshot() from public, anon, authenticated;
create trigger sentlog_collaboration_snapshot_guard
before insert or update or delete on public.sentlog_project_snapshots
for each row execute function sentlog_collaboration_private.guard_snapshot();

-- Database-triggered hints use a private owner-scoped topic. Clients have no
-- broadcast INSERT policy; they cannot fabricate a database change notification.
create policy sentlog_collaboration_receive on realtime.messages
for select to authenticated
using (extension = 'broadcast' and topic = 'sentlog-records:' || (select auth.uid())::text);

create or replace function sentlog_collaboration_private.notify_change()
returns trigger language plpgsql security definer set search_path = '' as $fn$
declare event_name text; value jsonb;
begin
  -- This function is callable only as a trigger and has no arbitrary payload or
  -- owner argument. Admin maintenance without a user session does not broadcast.
  if auth.uid() is null or auth.uid() is distinct from new.owner_id then return new; end if;
  if tg_table_schema <> 'public' then return new; end if;
  if tg_table_name = 'sentlog_project_snapshots' then
    event_name := 'records';
    value := jsonb_build_object('project_id', new.project_id, 'revision', new.revision);
  elsif tg_table_name = 'sentlog_assets' then
    if new.status = 'storage_deleted' then return new; end if;
    event_name := 'asset';value := jsonb_build_object('project_id', new.project_id);
  else return new;
  end if;
  perform realtime.send(value, event_name, 'sentlog-records:' || new.owner_id::text, true);
  return new;
end $fn$;
revoke all on function sentlog_collaboration_private.notify_change() from public, anon, authenticated;
create trigger sentlog_collaboration_snapshot_notify
after insert or update on public.sentlog_project_snapshots
for each row execute function sentlog_collaboration_private.notify_change();
create trigger sentlog_collaboration_asset_notify
after insert or update of status, storage_path, sha256 on public.sentlog_assets
for each row execute function sentlog_collaboration_private.notify_change();

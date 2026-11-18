-- Every fixture is rolled back inside the nested block, including auth users.
do $test$
<<fixture>>
declare
  owner_id uuid := gen_random_uuid(); other_owner uuid := gen_random_uuid();
  project_id uuid := gen_random_uuid(); device_id uuid := gen_random_uuid();
  client_key text := gen_random_uuid()::text;
  record_value jsonb; legacy jsonb; payload_value jsonb; next_payload jsonb; removed jsonb;
  failed boolean; total integer := 0; received bigint;
  extra integer := 0; case_label text; new_revision jsonb; extra_record jsonb; photo_value jsonb;
begin
  begin
    insert into auth.users(id) values(owner_id),(other_owner);
    insert into public.sentlog_projects(id,owner_id,name,client_key)
      values(project_id,owner_id,'Synthetic collaborative record test',client_key);
    insert into public.sentlog_devices(id,owner_id,device_name,device_type,active)
      values(device_id,owner_id,'Synthetic collaboration iPhone','iphone',true);
    record_value := '{"id":"synthetic-record","kind":"field-record","memo":"既存コメント","photos":[],"collab":{"version":1,"comments":{"comment-a":{"order":0,"revisions":[{"id":"comment-seed","parents":[],"text":"既存コメント","deleted":false,"actor":{"deviceId":null,"deviceName":"不明"},"at":0}]}},"fields":{"geometry":{"revisions":[{"id":"geometry-seed","parents":[],"value":{"kind":"field-record"},"actor":{"deviceId":null,"deviceName":"不明"},"at":0}]}},"photos":{},"deletion":{"revisions":[{"id":"deletion-seed","parents":[],"deleted":false,"observed":[],"actor":{"deviceId":null,"deviceName":"不明"},"at":0}]},"projection":{"memo":"既存コメント"}}}'::jsonb;
    record_value:=record_value || '{"point":{"x":20,"y":30},"customScalar":12,"surveyItems":["A","B"]}'::jsonb;
    record_value:=jsonb_set(record_value,'{collab,fields,geometry,revisions,0,value}',
      '{"kind":"field-record","point":{"x":20,"y":30}}');
    record_value:=jsonb_set(record_value,'{collab,fields,customScalar}',
      '{"revisions":[{"id":"scalar-seed","parents":[],"value":12,"actor":{"deviceId":null,"deviceName":"不明"},"at":0}]}');
    record_value:=jsonb_set(record_value,'{collab,fields,surveyItems}',
      '{"revisions":[{"id":"survey-seed","parents":[],"value":["A","B"],"actor":{"deviceId":null,"deviceName":"不明"},"at":0}]}');
    photo_value:=jsonb_build_object('id','photo-a','name','before.jpg','size',8,'type','image/jpeg','sha256',repeat('a',64));
    record_value:=jsonb_set(record_value,'{photos}',jsonb_build_array(photo_value));
    record_value:=jsonb_set(record_value,'{collab,photos,photo-a}',jsonb_build_object('revisions',jsonb_build_array(
      jsonb_build_object('id','photo-seed','parents','[]'::jsonb,'value',photo_value,'deleted',false,
                        'actor',jsonb_build_object('deviceId',null,'deviceName','不明'),'at',0))));
    legacy := jsonb_build_object('project',jsonb_build_object('id',client_key,'drawings',jsonb_build_array(jsonb_build_object('id','synthetic-drawing'))),
      'drawings',jsonb_build_array(jsonb_build_object('meta',jsonb_build_object('id','synthetic-drawing'),'state',jsonb_build_object('shapes',jsonb_build_array(record_value-'collab')))));
    -- Local-only caches must not become immutable network metadata.
    legacy:=jsonb_set(legacy,'{drawings,0,state,shapes,0,photos,0,localBlob}','true');
    legacy:=jsonb_set(legacy,'{drawings,0,state,shapes,0,photos,0,data}','"data:synthetic-local-cache"');
    payload_value := jsonb_set(jsonb_set(legacy,'{project,collaborationVersion}','1'),'{drawings,0,state,shapes}',jsonb_build_array(record_value));
    perform set_config('request.jwt.claim.sub',owner_id::text,true);
    perform set_config('request.headers','{}',true);
    execute 'set local role authenticated';
    insert into public.sentlog_project_snapshots(project_id,owner_id,revision,payload,updated_by_device)
      values(project_id,owner_id,1,legacy,device_id);
    total:=total+1;
    failed:=false;begin
      update public.sentlog_project_snapshots s set revision=2,payload=payload_value where s.project_id=fixture.project_id;
    exception when others then
      if position('COLLAB_UPGRADE_REQUIRED:' in sqlerrm)=0 then raise;end if;failed:=true;
    end;if not failed then raise exception 'Missing protocol header accepted';end if;total:=total+1;
    perform set_config('request.headers','{"x-client-info":"sentlog-collaboration/1"}',true);
    for case_label,next_payload in
      select * from (values
        ('legacy geometry changed',jsonb_set(payload_value,'{drawings,0,state,shapes,0,collab,fields,geometry,revisions,0,value,point,x}','21')),
        ('legacy scalar history missing',jsonb_set(payload_value,'{drawings,0,state,shapes,0,collab,fields}',
          (record_value #> '{collab,fields}') - 'customScalar')),
        ('legacy array value reordered',jsonb_set(payload_value,'{drawings,0,state,shapes,0,collab,fields,surveyItems,revisions,0,value}','["B","A"]')),
        ('legacy photo metadata changed',jsonb_set(payload_value,'{drawings,0,state,shapes,0,collab,photos,photo-a,revisions,0,value,name}','"different.jpg"')),
        ('legacy same-ID photo hash changed',jsonb_set(payload_value,'{drawings,0,state,shapes,0,collab,photos,photo-a,revisions,0,value,sha256}',to_jsonb(repeat('b',64))))
      ) as cases(label,payload)
    loop
      failed:=false;begin
        update public.sentlog_project_snapshots s set revision=2,payload=next_payload where s.project_id=fixture.project_id;
      exception when others then
        if position('COLLAB_HISTORY_REQUIRED:' in sqlerrm)=0 then raise;end if;failed:=true;
      end;
      if not failed then raise exception 'Unsafe upgrade accepted: %',case_label;end if;
      extra:=extra+1;
    end loop;
    update public.sentlog_project_snapshots s set revision=2,payload=payload_value where s.project_id=fixture.project_id;
    total:=total+1;
    perform set_config('request.headers','{}',true);
    failed:=false;begin
      update public.sentlog_project_snapshots s set revision=3 where s.project_id=fixture.project_id;
    exception when others then
      if position('COLLAB_UPGRADE_REQUIRED:' in sqlerrm)=0 then raise;end if;failed:=true;
    end;if not failed then raise exception 'Old client changed upgraded project';end if;total:=total+1;
    perform set_config('request.headers','{"x-client-info":"sentlog-collaboration/1"}',true);
    failed:=false;begin
      update public.sentlog_project_snapshots s set revision=3,payload=legacy where s.project_id=fixture.project_id;
    exception when others then
      if position('COLLAB_UPGRADE_REQUIRED:' in sqlerrm)=0 then raise;end if;failed:=true;
    end;if not failed then raise exception 'Schema downgrade accepted';end if;total:=total+1;
    new_revision:=jsonb_build_object('id','new-photo-revision','parents','[]'::jsonb,'value',photo_value,
      'deleted',false,'actor',jsonb_build_object('deviceId',device_id::text,'deviceName','Synthetic collaboration iPhone'),'at',1);
    extra_record:=jsonb_set(payload_value #> '{drawings,0}','{meta,id}','"second-drawing"');
    for case_label,next_payload in
      select * from (values
        ('old observed expanded',jsonb_set(payload_value,'{drawings,0,state,shapes,0,collab,deletion,revisions,0,observed}','["geometry-seed"]')),
        ('old parents expanded',jsonb_set(payload_value,'{drawings,0,state,shapes,0,collab,comments,comment-a,revisions}',jsonb_build_array(
          jsonb_set(record_value #> '{collab,comments,comment-a,revisions,0}','{parents}','["comment-peer"]'),
          jsonb_build_object('id','comment-peer','parents','[]'::jsonb,'text','追加','deleted',false,
            'actor',jsonb_build_object('deviceId',device_id::text,'deviceName','Synthetic collaboration iPhone'),'at',1)))),
        ('old value object extended',jsonb_set(payload_value,'{drawings,0,state,shapes,0,collab,fields,geometry,revisions,0,value,point,z}','99')),
        ('duplicate visible record',jsonb_set(payload_value,'{drawings,0,state,shapes}',jsonb_build_array(record_value,record_value))),
        ('duplicate live and tombstone record',jsonb_set(payload_value,'{drawings,0,state,collabDeletedRecords}',jsonb_build_array(record_value))),
        ('duplicate drawing',jsonb_set(payload_value,'{drawings}',jsonb_build_array(payload_value #> '{drawings,0}',payload_value #> '{drawings,0}'))),
        ('record moved without source history',jsonb_set(jsonb_set(payload_value,'{drawings}',jsonb_build_array(extra_record)),
          '{project,drawings}',jsonb_build_array(extra_record -> 'meta'))),
        ('same-ID clone hides missing source record',jsonb_set(jsonb_set(payload_value,'{drawings}',jsonb_build_array(
          jsonb_set(payload_value #> '{drawings,0}','{state,shapes}','[]'),extra_record)),
          '{project,drawings}',(payload_value #> '{project,drawings}') || jsonb_build_array(extra_record -> 'meta'))),
        ('project drawing list hides saved drawing',jsonb_set(payload_value,'{project,drawings}','[]')),
        ('missing deletion history',jsonb_set(payload_value,'{drawings,0,state,shapes,0,collab}',(record_value -> 'collab') - 'deletion')),
        ('missing revision parents',jsonb_set(payload_value,'{drawings,0,state,shapes,0,collab,comments,comment-a,revisions,0}',
          (record_value #> '{collab,comments,comment-a,revisions,0}') - 'parents')),
        ('cyclic revision parents',jsonb_set(payload_value,'{drawings,0,state,shapes,0,collab,comments,comment-a,revisions,0,parents}','["comment-seed"]')),
        ('missing revision actor',jsonb_set(payload_value,'{drawings,0,state,shapes,0,collab,comments,comment-a,revisions,0,actor}','{}')),
        ('same-ID new revision changes hash',jsonb_set(payload_value,'{drawings,0,state,shapes,0,collab,photos,photo-a,revisions}',
          (record_value #> '{collab,photos,photo-a,revisions}') || jsonb_build_array(jsonb_set(new_revision,'{value,sha256}',to_jsonb(repeat('b',64)))))),
        ('same-ID new revision changes byte size',jsonb_set(payload_value,'{drawings,0,state,shapes,0,collab,photos,photo-a,revisions}',
          (record_value #> '{collab,photos,photo-a,revisions}') || jsonb_build_array(jsonb_set(new_revision,'{value,size}','9')))),
        ('same-ID new revision changes MIME',jsonb_set(payload_value,'{drawings,0,state,shapes,0,collab,photos,photo-a,revisions}',
          (record_value #> '{collab,photos,photo-a,revisions}') || jsonb_build_array(jsonb_set(new_revision,'{value,type}','"image/png"'))))
      ) as cases(label,payload)
    loop
      failed:=false;begin
        update public.sentlog_project_snapshots s set revision=3,payload=next_payload where s.project_id=fixture.project_id;
      exception when others then
        if position('COLLAB_HISTORY_REQUIRED:' in sqlerrm)=0 then raise;end if;failed:=true;
      end;
      if not failed then raise exception 'Unsafe history accepted: %',case_label;end if;
      extra:=extra+1;
    end loop;
    -- These valid alternatives are tested in nested transactions, then rolled
    -- back so the remaining tests keep their original revision checkpoints.
    for case_label,next_payload in
      select * from (values
        ('same record ID in an independent drawing',jsonb_set(jsonb_set(payload_value,'{drawings}',
          (payload_value -> 'drawings') || jsonb_build_array(extra_record)),
          '{project,drawings}',(payload_value #> '{project,drawings}') || jsonb_build_array(extra_record -> 'meta'))),
        ('photo filename alternative preserves bytes',jsonb_set(payload_value,'{drawings,0,state,shapes,0,collab,photos,photo-a,revisions}',
          (record_value #> '{collab,photos,photo-a,revisions}') || jsonb_build_array(jsonb_set(new_revision,'{value,name}','"renamed.jpg"')))),
        ('missing photo identity may be enriched',jsonb_set(payload_value,'{drawings,0,state,shapes,0,collab,photos,photo-b}',
          jsonb_build_object('revisions',jsonb_build_array(
            jsonb_set(jsonb_set(new_revision,'{id}','"photo-b-initial"'),'{value}','{"id":"photo-b","name":"unknown.jpg"}'),
            jsonb_set(jsonb_set(new_revision,'{id}','"photo-b-verified"'),'{value}',photo_value || '{"id":"photo-b"}'::jsonb)))))
      ) as cases(label,payload)
    loop
      begin
        update public.sentlog_project_snapshots s set revision=3,payload=next_payload where s.project_id=fixture.project_id;
        raise exception using errcode='P2998',message='valid alternative rolled back';
      exception when sqlstate 'P2998' then null;
      end;
      extra:=extra+1;
    end loop;
    next_payload:=jsonb_set(payload_value,'{drawings,0,state,shapes,0,collab,comments,comment-a,revisions,0,text}','"改変"');
    failed:=false;begin
      update public.sentlog_project_snapshots s set revision=3,payload=next_payload where s.project_id=fixture.project_id;
    exception when others then
      if position('COLLAB_HISTORY_REQUIRED:' in sqlerrm)=0 then raise;end if;failed:=true;
    end;if not failed then raise exception 'Immutable revision changed';end if;total:=total+1;
    next_payload:=jsonb_set(payload_value,'{drawings,0,state,shapes,0,collab,comments,comment-a,order}','2');
    failed:=false;begin
      update public.sentlog_project_snapshots s set revision=3,payload=next_payload where s.project_id=fixture.project_id;
    exception when others then
      if position('COLLAB_HISTORY_REQUIRED:' in sqlerrm)=0 then raise;end if;failed:=true;
    end;if not failed then raise exception 'Comment order changed';end if;total:=total+1;
    next_payload:=jsonb_set(payload_value,'{drawings,0,state,shapes}','[]');
    failed:=false;begin
      update public.sentlog_project_snapshots s set revision=3,payload=next_payload where s.project_id=fixture.project_id;
    exception when others then
      if position('COLLAB_HISTORY_REQUIRED:' in sqlerrm)=0 then raise;end if;failed:=true;
    end;if not failed then raise exception 'Record vanished without history';end if;total:=total+1;
    next_payload:=jsonb_set(payload_value,'{drawings,0,state,shapes,0,collab,comments,comment-a,revisions}',
      (record_value #> '{collab,comments,comment-a,revisions}') || jsonb_build_array(jsonb_build_object('id','comment-edit','parents',jsonb_build_array('comment-seed'),'text','修正後','deleted',false,'actor',jsonb_build_object('deviceId',device_id::text,'deviceName','Synthetic collaboration iPhone'),'at',1)));
    next_payload:=jsonb_set(jsonb_set(next_payload,'{drawings,0,state,shapes,0,memo}','"修正後"'),'{drawings,0,state,shapes,0,collab,projection,memo}','"修正後"');
    update public.sentlog_project_snapshots s set revision=3,payload=next_payload where s.project_id=fixture.project_id;
    payload_value:=next_payload;total:=total+1;
    failed:=false;begin
      update public.sentlog_project_snapshots s set revision=3 where s.project_id=fixture.project_id;
    exception when others then
      if position('別端末の変更があります' in sqlerrm)=0 then raise;end if;failed:=true;
    end;if not failed then raise exception 'Stale revision bypassed CAS';end if;total:=total+1;
    begin
      next_payload:=jsonb_set(payload_value,'{drawings,0,state,shapes,0,collab,comments,comment-a,revisions}',jsonb_build_array(
        payload_value #> '{drawings,0,state,shapes,0,collab,comments,comment-a,revisions,1}',
        payload_value #> '{drawings,0,state,shapes,0,collab,comments,comment-a,revisions,0}'));
      update public.sentlog_project_snapshots s set revision=4,payload=next_payload where s.project_id=fixture.project_id;
      raise exception using errcode='P2998',message='valid revision ordering rolled back';
    exception when sqlstate 'P2998' then null;
    end;extra:=extra+1;
    removed:=payload_value #> '{drawings,0,state,shapes,0}';
    removed:=jsonb_set(removed,'{collab,deletion,revisions}',(removed #> '{collab,deletion,revisions}') ||
      jsonb_build_array(jsonb_build_object('id','record-delete','parents',jsonb_build_array('deletion-seed'),'deleted',true,'observed',jsonb_build_array('comment-seed','comment-edit','geometry-seed','scalar-seed','survey-seed','photo-seed'),'actor',jsonb_build_object('deviceId',device_id::text,'deviceName','Synthetic collaboration iPhone'),'at',2)));
    next_payload:=jsonb_set(jsonb_set(payload_value,'{drawings,0,state,shapes}','[]'),'{drawings,0,state,collabDeletedRecords}',jsonb_build_array(removed));
    update public.sentlog_project_snapshots s set revision=4,payload=next_payload where s.project_id=fixture.project_id;
    total:=total+1;
    begin
      extra_record:=jsonb_set(removed,'{collab,deletion,revisions}',(removed #> '{collab,deletion,revisions}') || jsonb_build_array(
        jsonb_build_object('id','destination-restore','parents','["record-delete"]'::jsonb,'deleted',false,
          'observed','["record-delete","comment-seed","comment-edit","geometry-seed","scalar-seed","survey-seed","photo-seed"]'::jsonb,
          'actor',jsonb_build_object('deviceId',device_id::text,'deviceName','Synthetic collaboration iPhone'),'at',3)));
      extra_record:=jsonb_build_object('meta',jsonb_build_object('id','destination-drawing'),
        'state',jsonb_build_object('shapes',jsonb_build_array(extra_record)));
      next_payload:=jsonb_set(jsonb_set(next_payload,'{drawings}',(next_payload -> 'drawings') || jsonb_build_array(extra_record)),
        '{project,drawings}',(next_payload #> '{project,drawings}') || jsonb_build_array(extra_record -> 'meta'));
      update public.sentlog_project_snapshots s set revision=5,payload=next_payload where s.project_id=fixture.project_id;
      raise exception using errcode='P2998',message='explicit source tombstone and destination restore rolled back';
    exception when sqlstate 'P2998' then null;
    end;extra:=extra+1;
    failed:=false;begin
      delete from public.sentlog_project_snapshots s where s.project_id=fixture.project_id;
    exception when others then
      if position('COLLAB_HISTORY_REQUIRED:' in sqlerrm)=0 then raise;end if;failed:=true;
    end;if not failed then raise exception 'Snapshot history deleted';end if;total:=total+1;
    -- Notifications contain only IDs/update numbers. The owner can read them.
    select count(*) into received from realtime.messages m where m.topic='sentlog-records:'||owner_id::text and m.event='records' and m.private;
    if received<4 then raise exception 'Private database notifications missing';end if;total:=total+1;
    execute 'reset role';
    perform realtime.send(jsonb_build_object('project_id',gen_random_uuid()),'records','sentlog-records:'||other_owner::text,true);
    execute 'set local role authenticated';
    if exists(select 1 from realtime.messages m where m.topic='sentlog-records:'||other_owner::text) then raise exception 'Other owner notifications readable';end if;total:=total+1;
    failed:=false;begin
      insert into realtime.messages(topic,extension,event,payload,private)
        values('sentlog-records:'||owner_id::text,'broadcast','records','{}',true);
    exception when insufficient_privilege then failed:=true;
    end;if not failed then raise exception 'Client fabricated database notification';end if;total:=total+1;
    execute 'reset role';
    if has_function_privilege('anon','sentlog_collaboration_private.notify_change()','EXECUTE') or
       has_function_privilege('authenticated','sentlog_collaboration_private.notify_change()','EXECUTE') then raise exception 'Private trigger publicly executable';end if;total:=total+1;
    -- Roll back the whole fixture subtransaction, keeping only the counter.
    raise exception using errcode='P2999',message='synthetic collaboration checks completed';
  exception when sqlstate 'P2999' then null;
  end;
  if total<>16 or extra<>26 then raise exception 'Incomplete collaboration checks: % base + % strict',total,extra;end if;
  if exists(select 1 from auth.users u where u.id in(owner_id,other_owner)) or
     exists(select 1 from public.sentlog_projects p where p.id=project_id) then raise exception 'Synthetic fixture was not rolled back';end if;
  perform set_config('sentlog.collaboration_test_count',(total+extra)::text,true);
end $test$;
select current_setting('sentlog.collaboration_test_count')::integer as passed, 'synthetic fixtures rolled back' as fixture_status;

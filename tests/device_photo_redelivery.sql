-- Synthetic fixtures only; run inside BEGIN/ROLLBACK, never commit them.
DO $setup$
DECLARE u uuid:=gen_random_uuid(); other_u uuid:=gen_random_uuid(); p uuid:=gen_random_uuid();
 donor uuid:=gen_random_uuid(); receiver uuid:=gen_random_uuid(); outsider uuid:=gen_random_uuid();
 unproven uuid:=gen_random_uuid(); pc uuid:=gen_random_uuid(); a uuid:=gen_random_uuid();
BEGIN
 INSERT INTO auth.users(id) VALUES(u),(other_u);
 INSERT INTO public.sentlog_projects(id,owner_id,name,client_key) VALUES(p,u,'Synthetic peer photo test',gen_random_uuid()::text);
 INSERT INTO public.sentlog_devices(id,owner_id,device_name,device_type,last_seen_at)
 VALUES(donor,u,'Synthetic donor','iphone',now()),(receiver,u,'Synthetic receiver','ipad',now()),
 (pc,u,'Synthetic PC','pc',now()),(unproven,u,'Unproven source','browser',now()),(outsider,other_u,'Other owner','iphone',now());
 INSERT INTO public.sentlog_assets(id,owner_id,project_id,source_device_id,kind,file_name,storage_path,mime_type,byte_size,sha256,status,client_key)
 VALUES(a,u,p,donor,'photo','synthetic.jpg',u||'/'||p||'/synthetic.jpg','image/jpeg',8,repeat('a',64),'storage_deleted',gen_random_uuid()::text);
 INSERT INTO public.sentlog_pc_receipts(asset_id,owner_id,pc_device_id,byte_size,sha256,pc_path)
 VALUES(a,u,pc,8,repeat('a',64),'Synthetic/Photo.jpg');
 INSERT INTO public.sentlog_pdf_requests(asset_id,owner_id,device_id,expected_sha256) VALUES(a,u,receiver,repeat('a',64));
 PERFORM set_config('request.jwt.claim.sub',u::text,true);
 PERFORM set_config('test.peer_owner',u::text,true);PERFORM set_config('test.peer_asset',a::text,true);
 PERFORM set_config('test.peer_donor',donor::text,true);PERFORM set_config('test.peer_receiver',receiver::text,true);
 PERFORM set_config('test.peer_outsider',outsider::text,true);PERFORM set_config('test.peer_unproven',unproven::text,true);
END $setup$;
SET LOCAL ROLE authenticated;
DO $tests$
DECLARE a uuid:=current_setting('test.peer_asset')::uuid; d uuid:=current_setting('test.peer_donor')::uuid;
 r jsonb; fail boolean; total integer:=0;
BEGIN
 fail:=false;BEGIN
 PERFORM public.sentlog_device_photo_redelivery_v1('claim',a,current_setting('test.peer_outsider')::uuid,repeat('a',64),8);
 EXCEPTION WHEN OTHERS THEN fail:=true;END;IF NOT fail THEN RAISE EXCEPTION 'cross-owner device allowed'; END IF;total:=total+1;
 fail:=false;BEGIN
 PERFORM public.sentlog_device_photo_redelivery_v1('claim',a,current_setting('test.peer_unproven')::uuid,repeat('a',64),8);
 EXCEPTION WHEN OTHERS THEN fail:=true;END;IF NOT fail THEN RAISE EXCEPTION 'unproven donor allowed'; END IF;total:=total+1;
 fail:=false;BEGIN
 PERFORM public.sentlog_device_photo_redelivery_v1('claim',a,d,repeat('b',64),8);
 EXCEPTION WHEN OTHERS THEN fail:=true;END;IF NOT fail THEN RAISE EXCEPTION 'wrong hash allowed'; END IF;total:=total+1;
 fail:=false;BEGIN
 PERFORM public.sentlog_device_photo_redelivery_v1('claim',a,d,repeat('a',64),9);
 EXCEPTION WHEN OTHERS THEN fail:=true;END;IF NOT fail THEN RAISE EXCEPTION 'wrong size allowed'; END IF;total:=total+1;
 r:=public.sentlog_device_photo_redelivery_v1('claim',a,d,repeat('a',64),8);
 IF NOT (r->>'claimed')::boolean THEN RAISE EXCEPTION 'valid donor failed'; END IF;
 PERFORM set_config('test.peer_token',r->>'token',true);PERFORM set_config('test.peer_path',r->>'storage_path',true);total:=total+1;
 r:=public.sentlog_device_photo_redelivery_v1('claim',a,d,repeat('a',64),8);
 IF (r->>'claimed')::boolean THEN RAISE EXCEPTION 'duplicate claim allowed'; END IF;total:=total+1;
 fail:=false;BEGIN
 PERFORM public.sentlog_device_photo_redelivery_v1('finish',a,d,repeat('a',64),8,gen_random_uuid());
 EXCEPTION WHEN OTHERS THEN fail:=true;END;IF NOT fail THEN RAISE EXCEPTION 'wrong token allowed'; END IF;total:=total+1;
 fail:=false;BEGIN
 PERFORM public.sentlog_device_photo_redelivery_v1('finish',a,d,repeat('a',64),8,current_setting('test.peer_token')::uuid);
 EXCEPTION WHEN OTHERS THEN fail:=true;END;IF NOT fail THEN RAISE EXCEPTION 'missing upload accepted'; END IF;total:=total+1;
 INSERT INTO storage.objects(bucket_id,name,owner_id,metadata)
 VALUES('sentlog-temp',current_setting('test.peer_path'),current_setting('test.peer_owner'),'{"size":8,"mimetype":"image/jpeg"}');
 r:=public.sentlog_device_photo_redelivery_v1('finish',a,d,repeat('a',64),8,current_setting('test.peer_token')::uuid);
 IF NOT (r->>'published')::boolean THEN RAISE EXCEPTION 'valid publish failed'; END IF;total:=total+1;
 IF NOT EXISTS(SELECT 1 FROM public.sentlog_assets WHERE id=a AND status='uploaded' AND sha256=repeat('a',64) AND byte_size=8 AND source_device_id=d) THEN RAISE EXCEPTION 'identity changed'; END IF;total:=total+1;
 IF NOT EXISTS(SELECT 1 FROM public.sentlog_pc_receipts WHERE asset_id=a AND pc_path='Synthetic/Photo.jpg') THEN RAISE EXCEPTION 'PC receipt lost'; END IF;total:=total+1;
 IF NOT EXISTS(SELECT 1 FROM public.sentlog_pdf_requests WHERE asset_id=a AND received_at IS NULL) THEN RAISE EXCEPTION 'false receiver acknowledgement'; END IF;total:=total+1;
 PERFORM set_config('request.jwt.claim.sub','',true);fail:=false;BEGIN
 PERFORM public.sentlog_device_photo_redelivery_v1('claim',a,d,repeat('a',64),8);
 EXCEPTION WHEN OTHERS THEN fail:=true;END;IF NOT fail THEN RAISE EXCEPTION 'missing auth allowed'; END IF;total:=total+1;
 PERFORM set_config('test.peer_passed',total::text,true);
END $tests$;
RESET ROLE;
DO $more$
DECLARE a uuid:=current_setting('test.peer_asset')::uuid; d uuid:=current_setting('test.peer_donor')::uuid;
 recv uuid:=current_setting('test.peer_receiver')::uuid; r jsonb; fail boolean; total int:=current_setting('test.peer_passed')::int;
BEGIN
 PERFORM set_config('request.jwt.claim.sub',current_setting('test.peer_owner'),true);
 UPDATE public.sentlog_assets SET status='storage_deleted',storage_deleted_at=now() WHERE id=a;
 UPDATE public.sentlog_devices SET last_seen_at=now()-interval '1 hour' WHERE id=recv;
 UPDATE public.sentlog_pdf_requests SET requested_at=now()-interval '1 hour' WHERE asset_id=a;
 r:=public.sentlog_device_photo_redelivery_v1('claim',a,d,repeat('a',64),8);
 IF (r->>'claimed')::boolean THEN RAISE EXCEPTION 'stale receiver allowed'; END IF;total:=total+1;
 UPDATE public.sentlog_devices SET last_seen_at=now(),active=false WHERE id=recv;
 r:=public.sentlog_device_photo_redelivery_v1('claim',a,d,repeat('a',64),8);
 IF (r->>'claimed')::boolean THEN RAISE EXCEPTION 'inactive receiver allowed'; END IF;total:=total+1;
 UPDATE public.sentlog_devices SET active=true WHERE id=recv;
 UPDATE public.sentlog_devices SET active=false WHERE id=d;
 fail:=false;BEGIN
 PERFORM public.sentlog_device_photo_redelivery_v1('claim',a,d,repeat('a',64),8);
 EXCEPTION WHEN OTHERS THEN fail:=true;END;IF NOT fail THEN RAISE EXCEPTION 'inactive donor allowed'; END IF;total:=total+1;
 UPDATE public.sentlog_devices SET active=true WHERE id=d;
 r:=public.sentlog_device_photo_redelivery_v1('claim',a,d,repeat('a',64),8);
 IF NOT (r->>'claimed')::boolean THEN RAISE EXCEPTION 'reopened receiver failed'; END IF;total:=total+1;
 UPDATE public.sentlog_pdf_leases SET expires_at=now()-interval '1 second' WHERE asset_id=a;
 fail:=false;BEGIN
 PERFORM public.sentlog_device_photo_redelivery_v1('finish',a,d,repeat('a',64),8,(r->>'token')::uuid);
 EXCEPTION WHEN OTHERS THEN fail:=true;END;IF NOT fail THEN RAISE EXCEPTION 'expired lease accepted'; END IF;total:=total+1;
 r:=public.sentlog_device_photo_redelivery_v1('claim',a,d,repeat('a',64),8);
 IF NOT (r->>'claimed')::boolean THEN RAISE EXCEPTION 'expired lease could not retry'; END IF;total:=total+1;
 PERFORM set_config('test.peer_passed',total::text,true);
END $more$;
SELECT current_setting('test.peer_passed') AS passed_checks,
 NOT has_function_privilege('anon','public.sentlog_device_photo_redelivery_v1(text,uuid,uuid,text,bigint,uuid)','EXECUTE') AS anon_denied;

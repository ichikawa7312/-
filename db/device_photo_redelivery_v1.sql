-- Additive v1.87 protocol. No project, annotation, photo, PC original or
-- existing PC RPC is replaced. Only verified, requested photo bytes are relayed.
CREATE OR REPLACE FUNCTION sentlog_archive_private.device_photo_redelivery_v1(
 p_action text,p_asset_id uuid,p_device_id uuid,p_sha256 text,p_byte_size bigint,p_token uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $peer$
DECLARE u uuid:=auth.uid(); a public.sentlog_assets%rowtype;
 lease public.sentlog_pdf_leases%rowtype; tok uuid; dest text; ext text;
BEGIN
 IF u IS NULL THEN RAISE EXCEPTION 'ログインしてください。'; END IF;
 IF p_action NOT IN ('claim','finish') OR p_action IS NULL THEN RAISE EXCEPTION '操作を確認できません。'; END IF;
 IF NOT EXISTS(SELECT 1 FROM public.sentlog_devices d WHERE d.id=p_device_id
   AND d.owner_id=u AND d.active AND d.device_type IN ('iphone','ipad','browser')
   AND NOT EXISTS(SELECT 1 FROM sentlog_archive_private.removed_device_registrations r WHERE r.device_id=d.id))
 THEN RAISE EXCEPTION '登録済みの送信端末を確認できません。'; END IF;
 SELECT x.* INTO a FROM public.sentlog_assets x JOIN public.sentlog_projects p ON p.id=x.project_id
 WHERE x.id=p_asset_id AND x.owner_id=u AND x.kind='photo' AND p.owner_id=u AND p.status='active' FOR UPDATE OF x;
 IF NOT FOUND THEN RAISE EXCEPTION '使用中の案件の写真を確認できません。'; END IF;
 IF lower(coalesce(p_sha256,''))<>lower(a.sha256) OR p_byte_size IS DISTINCT FROM a.byte_size
 THEN RAISE EXCEPTION '写真の内容照合に失敗しました。'; END IF;
 IF a.source_device_id IS DISTINCT FROM p_device_id AND NOT EXISTS(
   SELECT 1 FROM public.sentlog_asset_device_receipts r WHERE r.asset_id=a.id AND r.owner_id=u
   AND r.device_id=p_device_id AND lower(r.sha256)=lower(a.sha256) AND r.byte_size=a.byte_size)
 THEN RAISE EXCEPTION 'この端末の写真保存履歴を確認できません。'; END IF;
 IF NOT EXISTS(SELECT 1 FROM public.sentlog_pc_receipts r WHERE r.asset_id=a.id AND r.owner_id=u
   AND lower(r.sha256)=lower(a.sha256) AND r.byte_size=a.byte_size)
 THEN RAISE EXCEPTION '写真のPC保存確認がありません。'; END IF;
 IF p_action='claim' THEN
   IF a.status<>'storage_deleted' THEN RETURN jsonb_build_object('claimed',false); END IF;
   IF NOT EXISTS(SELECT 1 FROM public.sentlog_pdf_requests r JOIN public.sentlog_devices d ON d.id=r.device_id
     WHERE r.asset_id=a.id AND r.owner_id=u AND r.received_at IS NULL AND lower(r.expected_sha256)=lower(a.sha256)
     AND d.owner_id=u AND d.active AND d.id<>p_device_id AND d.device_type IN ('iphone','ipad','browser')
     AND (r.requested_at>=now()-interval '15 minutes' OR d.last_seen_at>=now()-interval '15 minutes')
     AND NOT EXISTS(SELECT 1 FROM sentlog_archive_private.removed_device_registrations x WHERE x.device_id=d.id))
   THEN RETURN jsonb_build_object('claimed',false); END IF;
   IF EXISTS(SELECT 1 FROM public.sentlog_pdf_leases WHERE asset_id=a.id AND expires_at>now())
   THEN RETURN jsonb_build_object('claimed',false); END IF;
   ext:=CASE lower(a.mime_type) WHEN 'image/jpeg' THEN '.jpg' WHEN 'image/png' THEN '.png'
     WHEN 'image/webp' THEN '.webp' WHEN 'image/heic' THEN '.heic' WHEN 'image/heif' THEN '.heif' ELSE NULL END;
   IF ext IS NULL OR a.byte_size<=0 OR a.byte_size>22*1024*1024 THEN RAISE EXCEPTION '写真形式またはサイズを確認してください。'; END IF;
   tok:=gen_random_uuid();dest:=u::text||'/'||a.project_id::text||'/device-redelivery/'||a.id::text||'/'||tok::text||ext;
   INSERT INTO public.sentlog_pdf_leases(asset_id,owner_id,device_id,token,storage_path,expires_at)
   VALUES(a.id,u,p_device_id,tok,dest,now()+interval '5 minutes')
   ON CONFLICT(asset_id) DO UPDATE SET owner_id=excluded.owner_id,device_id=excluded.device_id,
     token=excluded.token,storage_path=excluded.storage_path,expires_at=excluded.expires_at;
   RETURN jsonb_build_object('claimed',true,'token',tok,'storage_path',dest);
 END IF;
 SELECT * INTO lease FROM public.sentlog_pdf_leases WHERE asset_id=a.id AND owner_id=u
   AND device_id=p_device_id AND token=p_token AND expires_at>now();
 IF NOT FOUND THEN RAISE EXCEPTION '写真の再送期限が切れました。次回の確認で再試行します。'; END IF;
 IF a.status<>'storage_deleted' OR lease.storage_path NOT LIKE u::text||'/'||a.project_id::text||'/device-redelivery/'||a.id::text||'/%'
 THEN RAISE EXCEPTION '再送中に写真の登録が変更されました。'; END IF;
 IF NOT EXISTS(SELECT 1 FROM storage.objects o WHERE o.bucket_id='sentlog-temp' AND o.name=lease.storage_path
   AND (o.metadata->>'size')::bigint=a.byte_size)
 THEN RAISE EXCEPTION '写真の一時送信を確認できません。'; END IF;
 UPDATE public.sentlog_assets SET storage_path=lease.storage_path,status='uploaded',
   storage_deleted_at=null,pc_verified_at=null,uploaded_at=now(),updated_at=now() WHERE id=a.id;
 DELETE FROM public.sentlog_pdf_leases WHERE asset_id=a.id AND token=p_token;
 RETURN jsonb_build_object('published',true,'asset_id',a.id);
END $peer$;
REVOKE ALL ON FUNCTION sentlog_archive_private.device_photo_redelivery_v1(text,uuid,uuid,text,bigint,uuid) FROM public,anon;
GRANT EXECUTE ON FUNCTION sentlog_archive_private.device_photo_redelivery_v1(text,uuid,uuid,text,bigint,uuid) TO authenticated;
CREATE OR REPLACE FUNCTION public.sentlog_device_photo_redelivery_v1(
 p_action text,p_asset_id uuid,p_device_id uuid,p_sha256 text,p_byte_size bigint,p_token uuid DEFAULT NULL)
RETURNS jsonb LANGUAGE sql SECURITY INVOKER SET search_path='' AS $wrapper$
 SELECT sentlog_archive_private.device_photo_redelivery_v1(p_action,p_asset_id,p_device_id,p_sha256,p_byte_size,p_token);
$wrapper$;
REVOKE ALL ON FUNCTION public.sentlog_device_photo_redelivery_v1(text,uuid,uuid,text,bigint,uuid) FROM public,anon;
GRANT EXECUTE ON FUNCTION public.sentlog_device_photo_redelivery_v1(text,uuid,uuid,text,bigint,uuid) TO authenticated;

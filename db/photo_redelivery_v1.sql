-- Sentlog v1.41: request and redeliver PC-verified photographs for newly registered devices.
-- Reuse existing media request/lease tables but DO NOT alter the tested PDF RPCs.
-- No existing project/photo/archive data is removed or modified by this migration.

CREATE OR REPLACE FUNCTION public.sentlog_request_photo(p_asset_id uuid,p_device_id uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $photo_request$
DECLARE u uuid:=auth.uid(); a public.sentlog_assets%rowtype;
BEGIN
 IF u IS NULL THEN RAISE EXCEPTION 'ログインしてください。'; END IF;
 IF NOT EXISTS (
   SELECT 1 FROM public.sentlog_devices d
   WHERE d.id=p_device_id AND d.owner_id=u AND d.active AND d.device_type<>'pc'
     AND NOT EXISTS (SELECT 1 FROM sentlog_archive_private.removed_device_registrations x
        WHERE x.device_id=d.id)
 ) THEN RAISE EXCEPTION '登録済みの端末を確認できません。'; END IF;
 SELECT a0.* INTO a FROM public.sentlog_assets a0
   JOIN public.sentlog_projects p ON p.id=a0.project_id AND p.owner_id=u AND p.status='active'
   WHERE a0.id=p_asset_id AND a0.owner_id=u AND a0.kind='photo';
 IF NOT FOUND THEN RAISE EXCEPTION '同期対象の写真が見つかりません。'; END IF;
 IF NOT EXISTS (
  SELECT 1 FROM public.sentlog_pc_receipts r
  WHERE r.asset_id=a.id AND r.owner_id=u AND r.sha256=a.sha256 AND r.byte_size=a.byte_size
 ) THEN
  RETURN jsonb_build_object('requested',false,'reason','PCに照合済みの写真がありません。写真が残っている端末を開いてください。');
 END IF;
 INSERT INTO public.sentlog_pdf_requests(asset_id,device_id,owner_id,expected_sha256)
 VALUES(a.id,p_device_id,u,a.sha256)
 ON CONFLICT(asset_id,device_id) DO UPDATE SET expected_sha256=excluded.expected_sha256,received_at=null;
 RETURN jsonb_build_object('requested',true,'asset_id',a.id);
END $photo_request$;
REVOKE ALL ON FUNCTION public.sentlog_request_photo(uuid,uuid) FROM public,anon;
GRANT EXECUTE ON FUNCTION public.sentlog_request_photo(uuid,uuid) TO authenticated;

CREATE OR REPLACE FUNCTION public.sentlog_ack_photo(p_asset_id uuid,p_device_id uuid,p_sha256 text,p_byte_size bigint)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $photo_ack$
DECLARE u uuid:=auth.uid(); a public.sentlog_assets%rowtype;
BEGIN
 IF u IS NULL THEN RAISE EXCEPTION 'ログインしてください。'; END IF;
 SELECT * INTO a FROM public.sentlog_assets
  WHERE id=p_asset_id AND owner_id=u AND kind='photo' FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION '写真が見つかりません。';END IF;
 IF NOT EXISTS (
  SELECT 1 FROM public.sentlog_devices d WHERE d.id=p_device_id AND d.owner_id=u AND d.active
  AND NOT EXISTS (SELECT 1 FROM sentlog_archive_private.removed_device_registrations r
    WHERE r.device_id=d.id)
 ) THEN RAISE EXCEPTION '登録済みの端末を確認できません。';END IF;
 IF lower(coalesce(p_sha256,''))<>lower(a.sha256) OR p_byte_size IS DISTINCT FROM a.byte_size THEN
  RAISE EXCEPTION '写真のサイズまたはSHA-256が一致しません。';END IF;
 INSERT INTO public.sentlog_asset_device_receipts(asset_id,owner_id,device_id,received_at,sha256,byte_size)
 VALUES(a.id,u,p_device_id,now(),lower(a.sha256),a.byte_size)
 ON CONFLICT(asset_id,device_id) DO UPDATE SET
 received_at=excluded.received_at,sha256=excluded.sha256,byte_size=excluded.byte_size;
 UPDATE public.sentlog_pdf_requests SET received_at=now()
 WHERE asset_id=a.id AND device_id=p_device_id AND owner_id=u
  AND lower(expected_sha256)=lower(a.sha256);
 RETURN jsonb_build_object('received',true);
END $photo_ack$;
REVOKE ALL ON FUNCTION public.sentlog_ack_photo(uuid,uuid,text,bigint) FROM public,anon;
GRANT EXECUTE ON FUNCTION public.sentlog_ack_photo(uuid,uuid,text,bigint) TO authenticated;

CREATE OR REPLACE FUNCTION public.sentlog_claim_photo_redelivery(
 p_asset_id uuid,p_device_id uuid,p_sha256 text,p_byte_size bigint)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $photo_claim$
DECLARE u uuid:=auth.uid(); a public.sentlog_assets%rowtype; tok uuid:=gen_random_uuid();
 dest text; ext text;
BEGIN
 IF u IS NULL THEN RAISE EXCEPTION 'ログインしてください。'; END IF;
 IF NOT EXISTS (SELECT 1 FROM public.sentlog_devices d
  WHERE d.id=p_device_id AND d.owner_id=u AND d.active AND d.device_type='pc'
  AND NOT EXISTS(SELECT 1 FROM sentlog_archive_private.removed_device_registrations r
    WHERE r.device_id=d.id))
 THEN RAISE EXCEPTION '会社PCの登録を確認できません。'; END IF;
 SELECT a0.* INTO a FROM public.sentlog_assets a0
 JOIN public.sentlog_projects p ON p.id=a0.project_id AND p.owner_id=u AND p.status='active'
 WHERE a0.id=p_asset_id AND a0.owner_id=u AND a0.kind='photo' FOR UPDATE OF a0;
 IF NOT FOUND THEN RAISE EXCEPTION '写真が見つかりません。';END IF;
 IF lower(coalesce(p_sha256,''))<>lower(a.sha256) OR p_byte_size IS DISTINCT FROM a.byte_size THEN
  RAISE EXCEPTION '写真の内容照合に失敗しました。'; END IF;
 IF NOT EXISTS (SELECT 1 FROM public.sentlog_pc_receipts r
    WHERE r.asset_id=a.id AND r.owner_id=u AND r.sha256=a.sha256 AND r.byte_size=a.byte_size)
 THEN RAISE EXCEPTION 'PCの保存確認がありません。'; END IF;
 IF NOT EXISTS (SELECT 1 FROM public.sentlog_pdf_requests r
   JOIN public.sentlog_devices d ON d.id=r.device_id AND d.owner_id=u AND d.active
   WHERE r.asset_id=a.id AND r.owner_id=u AND r.received_at IS NULL
     AND lower(r.expected_sha256)=lower(a.sha256)
     AND NOT EXISTS (SELECT 1 FROM sentlog_archive_private.removed_device_registrations rem
       WHERE rem.device_id=d.id))
 THEN RETURN jsonb_build_object('claimed',false);END IF;
 IF a.status<>'storage_deleted' AND EXISTS
   (SELECT 1 FROM storage.objects WHERE bucket_id='sentlog-temp' AND name=a.storage_path)
 THEN RETURN jsonb_build_object('claimed',false);END IF;
 IF EXISTS (SELECT 1 FROM public.sentlog_pdf_leases WHERE asset_id=a.id AND expires_at>now())
 THEN RETURN jsonb_build_object('claimed',false); END IF;
 ext:=CASE lower(a.mime_type)
  WHEN 'image/jpeg' THEN '.jpg' WHEN 'image/png' THEN '.png'
  WHEN 'image/webp' THEN '.webp' WHEN 'image/heic' THEN '.heic'
  WHEN 'image/heif' THEN '.heif' ELSE NULL END;
 IF ext IS NULL THEN RAISE EXCEPTION '写真の形式がサポート対象外です。'; END IF;
 dest:=u::text||'/'||a.project_id::text||'/redelivery/'||a.id::text||'/'||tok::text||ext;
 INSERT INTO public.sentlog_pdf_leases(asset_id,owner_id,device_id,token,storage_path,expires_at)
 VALUES(a.id,u,p_device_id,tok,dest,now()+interval '5 minutes')
 ON CONFLICT(asset_id) DO UPDATE SET owner_id=excluded.owner_id,device_id=excluded.device_id,
 token=excluded.token,storage_path=excluded.storage_path,expires_at=excluded.expires_at;
 RETURN jsonb_build_object('claimed',true,'token',tok,'storage_path',dest);
END $photo_claim$;
REVOKE ALL ON FUNCTION public.sentlog_claim_photo_redelivery(uuid,uuid,text,bigint) FROM public,anon;
GRANT EXECUTE ON FUNCTION public.sentlog_claim_photo_redelivery(uuid,uuid,text,bigint) TO authenticated;

CREATE OR REPLACE FUNCTION public.sentlog_finish_photo_redelivery(p_asset_id uuid,p_device_id uuid,p_token uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $photo_finish$
DECLARE u uuid:=auth.uid(); a public.sentlog_assets%rowtype;
 lease public.sentlog_pdf_leases%rowtype;
BEGIN
 IF u IS NULL THEN RAISE EXCEPTION 'ログインしてください。'; END IF;
 IF NOT EXISTS (SELECT 1 FROM public.sentlog_devices d WHERE d.id=p_device_id
  AND d.owner_id=u AND d.active AND d.device_type='pc'
  AND NOT EXISTS(SELECT 1 FROM sentlog_archive_private.removed_device_registrations rem
   WHERE rem.device_id=d.id))
 THEN RAISE EXCEPTION '会社PCの登録を確認できません。';END IF;
 SELECT * INTO a FROM public.sentlog_assets
 WHERE id=p_asset_id AND owner_id=u AND kind='photo' FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION '写真が見つかりません。'; END IF;
 SELECT * INTO lease FROM public.sentlog_pdf_leases WHERE asset_id=a.id AND owner_id=u
  AND device_id=p_device_id AND token=p_token AND expires_at>now();
 IF NOT FOUND THEN RAISE EXCEPTION '再配信の期限切れです。';END IF;
 IF NOT EXISTS (SELECT 1 FROM storage.objects o WHERE o.bucket_id='sentlog-temp'
  AND o.name=lease.storage_path AND (o.metadata->>'size')::bigint=a.byte_size)
 THEN RAISE EXCEPTION '写真の一時送信を確認できません。'; END IF;
 UPDATE public.sentlog_assets SET storage_path=lease.storage_path,status='uploaded',
  storage_deleted_at=null,pc_verified_at=null,uploaded_at=now(),updated_at=now()
 WHERE id=a.id;
 DELETE FROM public.sentlog_pdf_leases WHERE asset_id=a.id AND token=p_token;
 RETURN jsonb_build_object('published',true,'asset_id',a.id);
END $photo_finish$;
REVOKE ALL ON FUNCTION public.sentlog_finish_photo_redelivery(uuid,uuid,uuid) FROM public,anon;
GRANT EXECUTE ON FUNCTION public.sentlog_finish_photo_redelivery(uuid,uuid,uuid) TO authenticated;

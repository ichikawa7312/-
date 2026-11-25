-- Additive draft: restore missing active-project shared files from verified PC or registered-device copies.
-- No fake receiving-device requests, no file or record deletions, no changes to
-- the original receipt ledger. The shared lease prevents concurrent legacy
-- redelivery from publishing a competing copy during this operation.
BEGIN;
CREATE FUNCTION sentlog_archive_private.active_media_restore_v1(
 p_action text,p_device_id uuid,p_after uuid DEFAULT NULL,p_asset_id uuid DEFAULT NULL,
 p_sha256 text DEFAULT NULL,p_byte_size bigint DEFAULT NULL,p_expected_path text DEFAULT NULL,
 p_expected_updated_at timestamptz DEFAULT NULL,p_token uuid DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=''
AS $fn$
DECLARE
 u uuid:=auth.uid(); a public.sentlog_assets%rowtype; l public.sentlog_pdf_leases%rowtype;
 r public.sentlog_pc_receipts%rowtype; mode text; ext text; prefix text; dest text;
 version text; tok uuid; rows jsonb; device_kind text; is_pc boolean;
BEGIN
 IF u IS NULL THEN RAISE EXCEPTION 'MEDIA_RESTORE_AUTH_REQUIRED' USING ERRCODE='28000'; END IF;
 IF p_action NOT IN ('list','claim','finish') OR p_action IS NULL
 THEN RAISE EXCEPTION 'MEDIA_RESTORE_ACTION_INVALID' USING ERRCODE='22023'; END IF;
 SELECT d.device_type INTO device_kind FROM public.sentlog_devices d
 WHERE d.id=p_device_id AND d.owner_id=u AND d.active AND d.device_type IN ('pc','iphone','ipad','browser')
   AND NOT EXISTS(SELECT 1 FROM sentlog_archive_private.removed_device_registrations x WHERE x.device_id=d.id);
 IF NOT FOUND THEN RAISE EXCEPTION 'MEDIA_RESTORE_DEVICE_REQUIRED' USING ERRCODE='42501'; END IF;
 is_pc:=device_kind='pc';
 IF p_action='list' THEN
   SELECT coalesce(jsonb_agg(to_jsonb(q) ORDER BY q.id),'[]'::jsonb) INTO rows FROM (
     SELECT a0.id,a0.project_id,a0.kind,a0.file_name,a0.mime_type,a0.byte_size,a0.sha256,
       a0.storage_path,a0.updated_at,CASE WHEN is_pc THEN r0.pc_path ELSE NULL END AS pc_path,
       a0.metadata->>'drawing_id' AS drawing_id,a0.metadata->>'photo_id' AS photo_id
     FROM public.sentlog_assets a0
     JOIN public.sentlog_projects p ON p.id=a0.project_id AND p.owner_id=u AND p.status='active'
     LEFT JOIN public.sentlog_pc_receipts r0 ON r0.asset_id=a0.id AND r0.owner_id=u
       AND lower(r0.sha256)=lower(a0.sha256) AND r0.byte_size=a0.byte_size
     WHERE a0.owner_id=u AND a0.kind IN ('photo','drawing') AND a0.status='storage_deleted'
       AND (p_after IS NULL OR a0.id>p_after)
       AND (is_pc OR (
         nullif(a0.metadata->>'drawing_id','') IS NOT NULL
         AND (a0.kind='drawing' OR nullif(a0.metadata->>'photo_id','') IS NOT NULL)
         AND (a0.source_device_id=p_device_id OR EXISTS(
           SELECT 1 FROM public.sentlog_asset_device_receipts d0
           WHERE d0.asset_id=a0.id AND d0.owner_id=u AND d0.device_id=p_device_id
             AND lower(d0.sha256)=lower(a0.sha256) AND d0.byte_size=a0.byte_size))))
       AND NOT EXISTS(SELECT 1 FROM sentlog_archive_private.retired_projects x WHERE x.project_id=p.id AND x.restored_at IS NULL)
       AND NOT EXISTS(SELECT 1 FROM sentlog_archive_private.jobs j WHERE j.project_id=p.id AND j.state='checking' AND j.expires_at>now())
     ORDER BY a0.id LIMIT 16
   ) q;
   RETURN jsonb_build_object('schema',1,'rows',rows);
 END IF;
 -- Recheck the device under a lock before issuing/consuming a lease.
 PERFORM 1 FROM public.sentlog_devices d WHERE d.id=p_device_id AND d.owner_id=u AND d.active AND d.device_type=device_kind
   AND NOT EXISTS(SELECT 1 FROM sentlog_archive_private.removed_device_registrations x WHERE x.device_id=d.id) FOR SHARE;
 IF NOT FOUND THEN RAISE EXCEPTION 'MEDIA_RESTORE_DEVICE_REQUIRED' USING ERRCODE='42501'; END IF;
 SELECT * INTO a FROM public.sentlog_assets WHERE id=p_asset_id AND owner_id=u AND kind IN ('photo','drawing') FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'MEDIA_RESTORE_ASSET_FORBIDDEN' USING ERRCODE='42501'; END IF;
 SELECT status INTO mode FROM public.sentlog_projects WHERE id=a.project_id AND owner_id=u FOR UPDATE;
 IF mode IS DISTINCT FROM 'active'
   OR EXISTS(SELECT 1 FROM sentlog_archive_private.retired_projects x WHERE x.project_id=a.project_id AND x.restored_at IS NULL)
   OR EXISTS(SELECT 1 FROM sentlog_archive_private.jobs j WHERE j.project_id=a.project_id AND j.state='checking' AND j.expires_at>now())
 THEN RAISE EXCEPTION 'MEDIA_RESTORE_PROJECT_FROZEN' USING ERRCODE='55000'; END IF;
 IF p_sha256 IS NULL OR lower(p_sha256) IS DISTINCT FROM lower(a.sha256)
   OR p_byte_size IS DISTINCT FROM a.byte_size OR p_expected_path IS NULL OR p_expected_updated_at IS NULL
 THEN RAISE EXCEPTION 'MEDIA_RESTORE_VERSION_CHANGED' USING ERRCODE='40001'; END IF;
 IF is_pc THEN
   SELECT * INTO r FROM public.sentlog_pc_receipts WHERE asset_id=a.id AND owner_id=u AND lower(sha256)=lower(a.sha256)
     AND byte_size=a.byte_size FOR SHARE;
   IF NOT FOUND OR nullif(btrim(r.pc_path),'') IS NULL
   THEN RAISE EXCEPTION 'MEDIA_RESTORE_PC_RECEIPT_REQUIRED' USING ERRCODE='55000'; END IF;
 ELSE
   IF nullif(a.metadata->>'drawing_id','') IS NULL OR
      (a.kind='photo' AND nullif(a.metadata->>'photo_id','') IS NULL) OR
      (a.source_device_id IS DISTINCT FROM p_device_id AND NOT EXISTS(
        SELECT 1 FROM public.sentlog_asset_device_receipts d0
        WHERE d0.asset_id=a.id AND d0.owner_id=u AND d0.device_id=p_device_id
          AND lower(d0.sha256)=lower(a.sha256) AND d0.byte_size=a.byte_size))
   THEN RAISE EXCEPTION 'MEDIA_RESTORE_SOURCE_REQUIRED' USING ERRCODE='42501'; END IF;
 END IF;
 ext:=CASE lower(a.mime_type) WHEN 'image/jpeg' THEN '.jpg' WHEN 'image/png' THEN '.png'
   WHEN 'image/webp' THEN '.webp' WHEN 'image/heic' THEN '.heic' WHEN 'image/heif' THEN '.heif'
   WHEN 'image/tiff' THEN '.tiff' WHEN 'application/pdf' THEN '.pdf' WHEN 'application/dxf' THEN '.dxf' ELSE NULL END;
 IF ext IS NULL OR a.byte_size<=0 OR a.byte_size>25*1024*1024
 THEN RAISE EXCEPTION 'MEDIA_RESTORE_FORMAT_OR_SIZE' USING ERRCODE='22023'; END IF;
 version:=pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(
   jsonb_build_array(p_expected_path,extract(epoch FROM p_expected_updated_at),lower(a.sha256),a.byte_size)::text,'UTF8')),'hex');
 prefix:=u::text||'/'||a.project_id::text||'/active-restore/'||a.id::text||'/'||lower(a.sha256)||'/'||version||'/';
 -- A lost completion response is safe to retry against the exact new path.
 IF p_action='finish' AND p_token IS NOT NULL AND a.status IN ('pc_verified','uploaded')
   AND a.storage_path=prefix||p_token::text||ext AND a.storage_deleted_at IS NULL
   AND EXISTS(SELECT 1 FROM storage.objects o WHERE o.bucket_id='sentlog-temp' AND o.name=a.storage_path
     AND (o.metadata->>'size')::bigint=a.byte_size)
 THEN RETURN jsonb_build_object('published',true,'asset_id',a.id,'already_published',true); END IF;
 IF a.status<>'storage_deleted' THEN
   RETURN jsonb_build_object('claimed',false,'published',false,'reason','already_available');
 END IF;
 IF a.storage_path IS DISTINCT FROM p_expected_path OR a.updated_at IS DISTINCT FROM p_expected_updated_at
 THEN RAISE EXCEPTION 'MEDIA_RESTORE_VERSION_CHANGED' USING ERRCODE='40001'; END IF;
 SELECT * INTO l FROM public.sentlog_pdf_leases WHERE asset_id=a.id FOR UPDATE;
 IF p_action='claim' THEN
   IF l.asset_id IS NOT NULL AND l.expires_at>now() AND
     (l.owner_id IS DISTINCT FROM u OR l.device_id IS DISTINCT FROM p_device_id
       OR l.storage_path IS DISTINCT FROM prefix||l.token::text||ext)
   THEN RETURN jsonb_build_object('claimed',false,'reason','leased'); END IF;
   -- An interrupted migration can reuse its immutable staged path, even after
   -- expiry, rather than sending the same successful upload again.
   IF l.asset_id IS NOT NULL AND l.owner_id=u AND l.storage_path=prefix||l.token::text||ext
   THEN tok:=l.token; ELSE tok:=pg_catalog.gen_random_uuid(); END IF;
   dest:=prefix||tok::text||ext;
   INSERT INTO public.sentlog_pdf_leases(asset_id,owner_id,device_id,token,storage_path,expires_at)
     VALUES(a.id,u,p_device_id,tok,dest,now()+interval '5 minutes')
   ON CONFLICT(asset_id) DO UPDATE SET owner_id=excluded.owner_id,device_id=excluded.device_id,
     token=excluded.token,storage_path=excluded.storage_path,expires_at=excluded.expires_at;
   RETURN jsonb_build_object('claimed',true,'token',tok,'storage_path',dest,
     'object_present',EXISTS(SELECT 1 FROM storage.objects o WHERE o.bucket_id='sentlog-temp' AND o.name=dest));
 END IF;
 IF p_token IS NULL OR l.asset_id IS NULL OR l.owner_id IS DISTINCT FROM u OR l.device_id IS DISTINCT FROM p_device_id
   OR l.token IS DISTINCT FROM p_token OR l.expires_at<=now() OR l.storage_path IS DISTINCT FROM prefix||p_token::text||ext
 THEN RAISE EXCEPTION 'MEDIA_RESTORE_LEASE_INVALID' USING ERRCODE='55000'; END IF;
 IF NOT EXISTS(SELECT 1 FROM storage.objects o WHERE o.bucket_id='sentlog-temp' AND o.name=l.storage_path
   AND (o.metadata->>'size')::bigint=a.byte_size)
 THEN RAISE EXCEPTION 'MEDIA_RESTORE_UPLOAD_INCOMPLETE' USING ERRCODE='55000'; END IF;
 -- The source device independently verifies local and downloaded staged bytes.
 -- A restored non-PC copy still requires a new verified PC backup. The old
 -- receipt ledger is not deleted or falsely promoted to a new proof.
 -- The server checks object size, not an independently computed object hash.
 UPDATE public.sentlog_assets SET storage_path=l.storage_path,status=CASE WHEN is_pc THEN 'pc_verified' ELSE 'uploaded' END,
   storage_deleted_at=null,pc_verified_at=CASE WHEN is_pc THEN coalesce(a.pc_verified_at,r.verified_at) ELSE NULL END,
   pc_path=CASE WHEN is_pc THEN r.pc_path ELSE NULL END,
   uploaded_at=now(),updated_at=now() WHERE id=a.id AND owner_id=u;
 DELETE FROM public.sentlog_pdf_leases WHERE asset_id=a.id AND token=p_token;
 RETURN jsonb_build_object('published',true,'asset_id',a.id,'already_published',false);
END $fn$;
REVOKE ALL ON FUNCTION sentlog_archive_private.active_media_restore_v1(text,uuid,uuid,uuid,text,bigint,text,timestamptz,uuid) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION sentlog_archive_private.active_media_restore_v1(text,uuid,uuid,uuid,text,bigint,text,timestamptz,uuid) TO authenticated;
CREATE FUNCTION public.sentlog_active_media_restore_v1(
 p_action text,p_device_id uuid,p_after uuid DEFAULT NULL,p_asset_id uuid DEFAULT NULL,
 p_sha256 text DEFAULT NULL,p_byte_size bigint DEFAULT NULL,p_expected_path text DEFAULT NULL,
 p_expected_updated_at timestamptz DEFAULT NULL,p_token uuid DEFAULT NULL)
RETURNS jsonb LANGUAGE sql SECURITY INVOKER SET search_path=''
AS $fn$ SELECT sentlog_archive_private.active_media_restore_v1($1,$2,$3,$4,$5,$6,$7,$8,$9) $fn$;
REVOKE ALL ON FUNCTION public.sentlog_active_media_restore_v1(text,uuid,uuid,uuid,text,bigint,text,timestamptz,uuid) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.sentlog_active_media_restore_v1(text,uuid,uuid,uuid,text,bigint,text,timestamptz,uuid) TO authenticated;
NOTIFY pgrst,'reload schema';
COMMIT;

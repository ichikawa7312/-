-- DRAFT / read-only protocol. Run in a disposable database first.
-- It returns ONLY the pending PC backup page plus compact counts, not every
-- retained media row and individual receipt. It performs no data writes.
BEGIN;
CREATE FUNCTION public.sentlog_pc_inventory_v1(
 p_project_ids uuid[],p_after uuid DEFAULT NULL,p_limit integer DEFAULT 200)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY INVOKER SET search_path=''
AS $fn$
DECLARE u uuid:=auth.uid(); result jsonb;
BEGIN
 IF u IS NULL THEN RAISE EXCEPTION 'PC_INVENTORY_AUTH_REQUIRED' USING ERRCODE='28000'; END IF;
 IF p_project_ids IS NULL OR cardinality(p_project_ids)>5000 OR p_limit IS NULL OR p_limit NOT BETWEEN 1 AND 200
 THEN RAISE EXCEPTION 'PC_INVENTORY_INVALID' USING ERRCODE='22023'; END IF;
 WITH eligible AS MATERIALIZED (
  SELECT a.id,a.kind,a.status,a.byte_size,
    coalesce(r.asset_id IS NOT NULL AND lower(r.sha256)=lower(a.sha256) AND r.byte_size=a.byte_size,false) AS receipt_ok
  FROM public.sentlog_assets a
  JOIN public.sentlog_projects p ON p.id=a.project_id AND p.owner_id=u AND p.status='active'
  LEFT JOIN public.sentlog_pc_receipts r ON r.asset_id=a.id AND r.owner_id=u
  WHERE a.owner_id=u AND a.project_id=ANY(p_project_ids) AND a.kind IN ('photo','drawing')
 ),
 page_ids AS (
  SELECT id,receipt_ok FROM eligible
  WHERE status IN ('uploaded','pc_verified') AND NOT(status='pc_verified' AND receipt_ok)
    AND (p_after IS NULL OR id>p_after)
  ORDER BY id LIMIT p_limit
 ),
 page AS (
  SELECT a.id,a.project_id,a.kind,a.file_name,a.storage_path,a.mime_type,a.byte_size,a.sha256,a.status,a.captured_at,a.metadata,q.receipt_ok AS "pcReceiptVerified"
  FROM page_ids q JOIN public.sentlog_assets a ON a.id=q.id AND a.owner_id=u
 )
 SELECT jsonb_build_object(
  'schema',1,
  'rows',(SELECT coalesce(jsonb_agg(to_jsonb(page) ORDER BY id),'[]'::jsonb) FROM page),
  'retainedDrawings',count(*) FILTER(WHERE kind='drawing' AND status='pc_verified' AND receipt_ok),
  'retainedPhotos',count(*) FILTER(WHERE kind='photo' AND status='pc_verified' AND receipt_ok),
  'pendingBackups',count(*) FILTER(WHERE status IN ('uploaded','pc_verified') AND NOT(status='pc_verified' AND receipt_ok)),
  'cloudMissing',count(*) FILTER(WHERE status='storage_deleted'),
  'cloudMissingBytes',coalesce(sum(byte_size) FILTER(WHERE status='storage_deleted'),0),
  'cloudMissingWithoutReceipt',count(*) FILTER(WHERE status='storage_deleted' AND NOT receipt_ok)
 ) INTO result FROM eligible;
 RETURN result;
END $fn$;
REVOKE ALL ON FUNCTION public.sentlog_pc_inventory_v1(uuid[],uuid,integer) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.sentlog_pc_inventory_v1(uuid[],uuid,integer) TO authenticated;
NOTIFY pgrst,'reload schema';
COMMIT;

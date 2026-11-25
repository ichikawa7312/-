-- Draft migration: cache only snapshot-derived receipt fields.
-- Do not apply before isolated SQL rehearsal, backup and release approval.
-- Public RPCs, original snapshots/records, proof hashes and dynamic state are unchanged.
BEGIN;
CREATE FUNCTION sentlog_delta_private.baseline_receipt_static_v1(v jsonb)
RETURNS jsonb LANGUAGE sql IMMUTABLE SECURITY INVOKER SET search_path=''
AS $fn$
 SELECT pg_catalog.jsonb_build_object(
  'clientProjectId',v#>>'{project,id}',
  'drawingIds',(SELECT coalesce(pg_catalog.jsonb_agg(d.value->'id' ORDER BY d.pos),'[]'::jsonb)
    FROM pg_catalog.jsonb_array_elements(v#>'{project,drawings}') WITH ORDINALITY d(value,pos)),
  'metadataCount',pg_catalog.jsonb_array_length(v->'drawings')+1,
  'metadataManifestSha256',sentlog_delta_private.json_digest(
    (SELECT pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object('ordinal',m.ordinal,
      'kind',m.kind,'key',m.key,'sha256',sentlog_delta_private.json_digest(m.metadata)) ORDER BY m.ordinal)
     FROM sentlog_delta_private.baseline_metadata(v) m)))
$fn$;
REVOKE ALL ON FUNCTION sentlog_delta_private.baseline_receipt_static_v1(jsonb) FROM PUBLIC,anon,authenticated;

-- The database computes this from the actual snapshot and automatically
-- recomputes it on snapshot replacement. No client-writable cache or stale
-- digest can bypass the existing content verification.
ALTER TABLE sentlog_delta_private.baselines ADD COLUMN receipt_static_v1 jsonb
 GENERATED ALWAYS AS (sentlog_delta_private.baseline_receipt_static_v1(snapshot)) STORED NOT NULL;

CREATE OR REPLACE FUNCTION sentlog_delta_private.baseline_receipt(b sentlog_delta_private.baselines)
RETURNS jsonb LANGUAGE sql STABLE SECURITY INVOKER SET search_path=''
AS $fn$
 SELECT b.receipt_static_v1 || pg_catalog.jsonb_build_object(
  'schema',1,'baselineId',b.id,'ownerId',b.owner_id,'projectId',b.project_id,
  'snapshotRevision',b.snapshot_revision,'cursor',0,'recordCount',b.record_count,
  'importedCount',b.imported_count,'snapshotSha256',b.snapshot_sha256,
  'manifestSha256',b.manifest_sha256,'hashFormat','postgres-jsonb-text-sha256-v1',
  'state',b.state,'deltaEnabled',coalesce((SELECT h.enabled
    FROM sentlog_delta_private.heads h WHERE h.project_id=b.project_id AND h.owner_id=b.owner_id),false),
  'deviceMigrationVerified',false,'assetDeliveryVerified',false)
$fn$;
REVOKE ALL ON FUNCTION sentlog_delta_private.baseline_receipt(sentlog_delta_private.baselines) FROM PUBLIC,anon,authenticated;
COMMIT;

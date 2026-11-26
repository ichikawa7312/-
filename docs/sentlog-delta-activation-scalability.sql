-- Scalable metadata reconstruction and concentrated drawing projection.
-- Preserve immutable histories, every graph/identity/membership check, triggers,
-- authorization, certificate publication and the atomic activation transaction.
-- No business rows, role settings, grants or rollout flags change on install.
BEGIN;
DO $scalability_preflight$
BEGIN
 IF pg_catalog.to_regprocedure('sentlog_delta_private.project_snapshot(uuid,text,jsonb)') IS NULL OR
    pg_catalog.to_regprocedure('sentlog_delta_private.materialize_metadata_document(text,jsonb)') IS NULL OR
    pg_catalog.to_regprocedure('sentlog_delta_private.seed_metadata_baseline(uuid,uuid,uuid)') IS NULL OR
    pg_catalog.to_regprocedure('public.sentlog_delta_activate_baseline_v1(uuid,uuid,uuid,jsonb)') IS NULL THEN
   RAISE EXCEPTION 'DELTA_ACTIVATION_SCALABILITY_PREREQUISITE' USING ERRCODE='55000'; END IF;
END $scalability_preflight$;

-- Build every direct parent/child edge once. Include implicit parent paths:
-- an unseen descendant can outlive a deleted or absent parent node.
CREATE OR REPLACE FUNCTION sentlog_delta_private.metadata_child_index(nodes jsonb)
RETURNS jsonb LANGUAGE sql IMMUTABLE SECURITY INVOKER SET search_path=''
AS $fn$
 WITH paths AS (
   SELECT n.key,pg_catalog.array_agg(p.value ORDER BY p.pos) AS items
   FROM pg_catalog.jsonb_each(nodes) n
   CROSS JOIN LATERAL pg_catalog.jsonb_array_elements_text(n.value->'path') WITH ORDINALITY p(value,pos)
   GROUP BY n.key
 ), edges AS (
   -- Canonical jsonb path text is an exact private lookup key. Re-hashing each
   -- repeated parent prefix made the index cost more than the removed scans.
   SELECT DISTINCT pg_catalog.to_jsonb(p.items[1:g.depth])::text AS parent_key,
     p.items[g.depth+1] AS child
   FROM paths p CROSS JOIN LATERAL pg_catalog.generate_series(0,pg_catalog.cardinality(p.items)-1) g(depth)
 ), children AS (
   SELECT parent_key,pg_catalog.jsonb_agg(child ORDER BY child COLLATE "C") AS items
   FROM edges GROUP BY parent_key
 ) SELECT coalesce(pg_catalog.jsonb_object_agg(parent_key,items),'{}'::jsonb) FROM children
$fn$;


CREATE OR REPLACE FUNCTION sentlog_delta_private.build_metadata_node_indexed(
  nodes jsonb,child_index jsonb,path jsonb,record_id text,identity jsonb
) RETURNS jsonb LANGUAGE plpgsql SECURITY INVOKER SET search_path=''
AS $fn$
DECLARE item jsonb; node jsonb; child text; built jsonb; result jsonb:='{}'::jsonb;
  conflicts jsonb:='[]'::jsonb; unseen jsonb; children text[]; head_ids jsonb;
BEGIN
 item:=nodes->sentlog_delta_private.metadata_field_key(path);node:=item->'node';
 SELECT coalesce(pg_catalog.array_agg(value ORDER BY pos),ARRAY[]::text[]) INTO children
 FROM pg_catalog.jsonb_array_elements_text(coalesce(child_index->(path::text),'[]'::jsonb))
 WITH ORDINALITY child(value,pos);
 IF node IS NOT NULL AND node<>'null'::jsonb AND node->>'type'<>'object' THEN
   -- A leaf cannot hide an unseen descendant. Avoid rescanning all document
   -- fields for every scalar leaf; non-leaf conflict logic below is unchanged.
   IF pg_catalog.cardinality(children)=0 THEN
     RETURN pg_catalog.jsonb_build_object('present',node->>'type'<>'absent','value',node->'value','conflicts',conflicts);
   END IF;
   SELECT coalesce(pg_catalog.jsonb_agg(h.value->'id' ORDER BY (h.value->>'id') COLLATE "C"),'[]'::jsonb) INTO unseen
   FROM pg_catalog.jsonb_each(nodes) n CROSS JOIN LATERAL pg_catalog.jsonb_array_elements(n.value#>'{reg,heads}') h(value)
   WHERE sentlog_delta_private.metadata_descendant(n.value->'path',path) AND NOT (coalesce(node->'observed','[]'::jsonb) ? (h.value->>'id'));
   IF pg_catalog.jsonb_array_length(unseen)=0 THEN
     RETURN pg_catalog.jsonb_build_object('present',node->>'type'<>'absent','value',node->'value','conflicts',conflicts);
   END IF;
   SELECT pg_catalog.jsonb_agg(h.value->'id' ORDER BY (h.value->>'id') COLLATE "C") INTO head_ids
     FROM pg_catalog.jsonb_array_elements(item#>'{reg,heads}') h(value);
   conflicts:=conflicts||pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object('kind','metadata-structure',
     'recordId',record_id,'drawingId',identity->'drawingId','path',path,'key',item->>'key',
     'headIds',head_ids,'unseenHeadIds',unseen,'candidates',item#>'{reg,heads}'));
 END IF;
 IF (node IS NULL OR node='null'::jsonb) AND pg_catalog.cardinality(children)=0 THEN
   RETURN pg_catalog.jsonb_build_object('present',false,'value',NULL,'conflicts',conflicts); END IF;
 FOREACH child IN ARRAY children LOOP
   built:=sentlog_delta_private.build_metadata_node_indexed(nodes,child_index,path||pg_catalog.jsonb_build_array(child),record_id,identity);
   conflicts:=conflicts||(built->'conflicts');
   IF built->'present'='true'::jsonb THEN result:=result||pg_catalog.jsonb_build_object(child,built->'value'); END IF;
 END LOOP;
 RETURN pg_catalog.jsonb_build_object('present',true,'value',result,'conflicts',conflicts);
END $fn$;

-- Retain the existing private helper contract for independent callers.
CREATE OR REPLACE FUNCTION sentlog_delta_private.build_metadata_node(
 nodes jsonb,path jsonb,record_id text,identity jsonb
) RETURNS jsonb LANGUAGE sql SECURITY INVOKER SET search_path=''
AS $fn$ SELECT sentlog_delta_private.build_metadata_node_indexed(nodes,
 sentlog_delta_private.metadata_child_index(nodes),path,record_id,identity) $fn$;
REVOKE ALL ON FUNCTION sentlog_delta_private.metadata_child_index(jsonb),
 sentlog_delta_private.build_metadata_node_indexed(jsonb,jsonb,jsonb,text,jsonb) FROM PUBLIC,anon,authenticated;


CREATE OR REPLACE FUNCTION sentlog_delta_private.materialize_metadata_document(record_id text,collab jsonb)
RETURNS jsonb LANGUAGE plpgsql SECURITY INVOKER SET search_path=''
AS $fn$
DECLARE raw jsonb; identity jsonb; expected text; ent record; revision jsonb; node jsonb; path jsonb; first_path jsonb;
  reg jsonb; nodes jsonb:='{}'::jsonb; child_index jsonb; node_keys text[]:=ARRAY[]::text[]; node_values jsonb[]:=ARRAY[]::jsonb[]; conflicts jsonb:='[]'::jsonb; result jsonb; built jsonb; root_name text; heads jsonb; common_heads jsonb;
BEGIN
 raw:=sentlog_delta_private.project_record(record_id,collab);identity:=raw#>'{record,metaIdentity}';
 IF pg_catalog.jsonb_typeof(identity) IS DISTINCT FROM 'object' OR identity->'version' IS DISTINCT FROM '1'::jsonb OR
   identity->>'kind' NOT IN ('project','drawing') OR NOT sentlog_delta_private.valid_id(identity->'localProjectId') OR
   (identity->>'kind'='drawing' AND (NOT sentlog_delta_private.valid_id(identity->'drawingId') OR identity->>'drawingId'='@sentlog:metadata:v1')) THEN
   RAISE EXCEPTION 'DELTA_METADATA_IDENTITY_INVALID' USING ERRCODE='22023'; END IF;
 expected:=CASE WHEN identity->>'kind'='project' THEN 'project' ELSE 'drawing:'||sentlog_delta_private.metadata_hash(identity->>'drawingId') END;
 IF record_id<>expected OR collab->'comments'<>'{}'::jsonb OR collab->'photos'<>'{}'::jsonb OR NOT (collab->'fields' ? 'geometry') OR
   EXISTS(SELECT 1 FROM pg_catalog.jsonb_array_elements(collab#>'{fields,metaIdentity,revisions}') r(value)
     WHERE r.value->'unset'='true'::jsonb OR r.value->'value' IS DISTINCT FROM identity) OR
   EXISTS(SELECT 1 FROM pg_catalog.jsonb_array_elements(collab#>'{fields,geometry,revisions}') r(value)
     WHERE r.value->'unset'='true'::jsonb OR r.value->'value' IS DISTINCT FROM '{}'::jsonb) THEN
   RAISE EXCEPTION 'DELTA_METADATA_IDENTITY_INVALID' USING ERRCODE='22023'; END IF;
 FOR ent IN SELECT key,value FROM pg_catalog.jsonb_each(collab->'fields') ORDER BY key COLLATE "C" LOOP
   IF ent.key IN ('geometry','metaIdentity') THEN CONTINUE; END IF;
   IF ent.key !~ '^m:[a-f0-9]{64}$' THEN RAISE EXCEPTION 'DELTA_METADATA_FIELD_INVALID' USING ERRCODE='22023'; END IF;
   first_path:=NULL;
   FOR revision IN SELECT value FROM pg_catalog.jsonb_array_elements(ent.value->'revisions') LOOP
     node:=revision->'value';path:=node->'path';
     IF revision->'unset'='true'::jsonb OR pg_catalog.jsonb_typeof(node) IS DISTINCT FROM 'object' OR
       pg_catalog.jsonb_typeof(path) IS DISTINCT FROM 'array' OR pg_catalog.jsonb_array_length(path) NOT BETWEEN 1 AND 48 OR
       node->>'type' NOT IN ('object','value','absent') OR EXISTS(SELECT 1 FROM pg_catalog.jsonb_array_elements(path) p(value) WHERE pg_catalog.jsonb_typeof(p.value)<>'string') THEN
       RAISE EXCEPTION 'DELTA_METADATA_NODE_INVALID' USING ERRCODE='22023'; END IF;
     IF sentlog_delta_private.metadata_field_key(path)<>ent.key OR (first_path IS NOT NULL AND first_path<>path) THEN
       RAISE EXCEPTION 'DELTA_METADATA_PATH_COLLISION' USING ERRCODE='22023'; END IF;
     first_path:=path;
     IF (identity->>'kind'='project' AND path->>0<>'project') OR
       (identity->>'kind'='drawing' AND path->>0 NOT IN ('meta','state','order')) OR
       (pg_catalog.jsonb_array_length(path)=1 AND node->>'type'<>'object' AND path->>0<>'order') OR
       (pg_catalog.jsonb_array_length(path)>1 AND (
         (path->>0='project' AND path->>1 IN ('id','drawings','updatedAt','collaborationVersion','deltaMetadata')) OR
         (path->>0='meta' AND path->>1 IN ('id','updatedAt','shapeCount','photoCount')) OR
         (path->>0='state' AND path->>1 IN ('shapes','collabDeletedRecords','currentPage','width','height','pdfPageInfo','labelSize','nextGlobalNo','typeCounters')) OR path->>0='order')) OR
       (node->>'type'='value' AND (NOT (node ? 'value') OR pg_catalog.jsonb_typeof(node->'value')='object')) THEN
       RAISE EXCEPTION 'DELTA_METADATA_NODE_INVALID' USING ERRCODE='22023'; END IF;
     IF node ? 'observed' THEN
       IF pg_catalog.jsonb_typeof(node->'observed') IS DISTINCT FROM 'array' OR EXISTS(
          SELECT 1 FROM pg_catalog.jsonb_array_elements(node->'observed') o(value) WHERE pg_catalog.jsonb_typeof(o.value)<>'string') OR
          pg_catalog.jsonb_array_length(node->'observed')<>(SELECT count(DISTINCT value) FROM pg_catalog.jsonb_array_elements_text(node->'observed')) THEN
         RAISE EXCEPTION 'DELTA_METADATA_OBSERVED_INVALID' USING ERRCODE='22023'; END IF;
       IF EXISTS(SELECT 1 FROM pg_catalog.jsonb_array_elements_text(node->'observed') o(id) WHERE NOT EXISTS(
         SELECT 1 FROM pg_catalog.jsonb_each(collab->'fields') child CROSS JOIN LATERAL pg_catalog.jsonb_array_elements(child.value->'revisions') r(value)
         WHERE child.key LIKE 'm:%' AND r.value->>'id'=o.id AND sentlog_delta_private.metadata_descendant(r.value#>'{value,path}',path))) THEN
         RAISE EXCEPTION 'DELTA_METADATA_OBSERVED_INVALID' USING ERRCODE='22023'; END IF;
     END IF;
   END LOOP;
   reg:=sentlog_delta_private.project_register(ent.value,'field');
   node_keys:=pg_catalog.array_append(node_keys,ent.key);
   node_values:=pg_catalog.array_append(node_values,pg_catalog.jsonb_build_object('key',ent.key,'path',first_path,'reg',reg,'node',reg#>'{selected,value}'));
   IF reg->'conflict'='true'::jsonb THEN
     SELECT pg_catalog.jsonb_agg(h.value->'id' ORDER BY (h.value->>'id') COLLATE "C") INTO heads FROM pg_catalog.jsonb_array_elements(reg->'heads') h(value);
     SELECT coalesce(pg_catalog.jsonb_agg(h.value->'id' ORDER BY (h.value->>'id') COLLATE "C"),'[]'::jsonb) INTO common_heads FROM pg_catalog.jsonb_array_elements(reg->'commonHeads') h(value);
     conflicts:=conflicts||pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object('kind','metadata-field','recordId',record_id,
       'drawingId',identity->'drawingId','path',first_path,'key',ent.key,'headIds',heads,'candidates',reg->'heads','commonHeadIds',common_heads));
   END IF;
 END LOOP;
 SELECT coalesce(pg_catalog.jsonb_object_agg(node_keys[i],node_values[i] ORDER BY i),'{}'::jsonb) INTO nodes
 FROM pg_catalog.generate_subscripts(node_keys,1) s(i);
 child_index:=sentlog_delta_private.metadata_child_index(nodes);
 result:=pg_catalog.jsonb_build_object('identity',identity,'kind',identity->'kind','deleted',raw->'deleted','pendingDelete',raw->'pendingDelete');
 FOREACH root_name IN ARRAY CASE WHEN identity->>'kind'='project' THEN ARRAY['project'] ELSE ARRAY['meta','state','order'] END LOOP
   IF NOT (nodes ? sentlog_delta_private.metadata_field_key(pg_catalog.jsonb_build_array(root_name))) THEN
     RAISE EXCEPTION 'DELTA_METADATA_ROOT_MISSING' USING ERRCODE='22023'; END IF;
   built:=sentlog_delta_private.build_metadata_node_indexed(nodes,child_index,pg_catalog.jsonb_build_array(root_name),record_id,identity);
   conflicts:=conflicts||(built->'conflicts');
   IF built->'present'='true'::jsonb THEN result:=result||pg_catalog.jsonb_build_object(root_name,built->'value');
   ELSIF root_name<>'order' THEN result:=result||pg_catalog.jsonb_build_object(root_name,'{}'::jsonb);
   ELSIF nodes#>ARRAY[sentlog_delta_private.metadata_field_key('["order"]'::jsonb),'reg','conflict']='true'::jsonb THEN
     result:=result||pg_catalog.jsonb_build_object('order',0); END IF;
 END LOOP;
 IF identity->>'kind'='drawing' AND pg_catalog.jsonb_typeof(result->'order') IS DISTINCT FROM 'number' THEN
   RAISE EXCEPTION 'DELTA_METADATA_ORDER_INVALID' USING ERRCODE='22023'; END IF;
 RETURN result||pg_catalog.jsonb_build_object('conflicts',conflicts);
END $fn$;

CREATE OR REPLACE FUNCTION sentlog_delta_private.seed_metadata_document(
  kind text,local_project_id text,drawing_id text,metadata jsonb
) RETURNS jsonb LANGUAGE plpgsql SECURITY INVOKER SET search_path=''
AS $fn$
DECLARE record_id text; identity jsonb; fields jsonb; c jsonb; row record; value jsonb;
 field_keys text[]:=ARRAY[]::text[]; field_values jsonb[]:=ARRAY[]::jsonb[];
BEGIN
 IF kind NOT IN ('project','drawing') OR NOT sentlog_delta_private.valid_id(pg_catalog.to_jsonb(local_project_id)) OR
   (kind='drawing' AND (NOT sentlog_delta_private.valid_id(pg_catalog.to_jsonb(drawing_id)) OR drawing_id='@sentlog:metadata:v1')) THEN
   RAISE EXCEPTION 'DELTA_METADATA_IDENTITY_INVALID' USING ERRCODE='22023'; END IF;
 record_id:=CASE WHEN kind='project' THEN 'project' ELSE 'drawing:'||sentlog_delta_private.metadata_hash(drawing_id) END;
 identity:=pg_catalog.jsonb_build_object('version',1,'kind',kind,'localProjectId',local_project_id)||
   CASE WHEN kind='drawing' THEN pg_catalog.jsonb_build_object('drawingId',drawing_id) ELSE '{}'::jsonb END;
 fields:=pg_catalog.jsonb_build_object('geometry',pg_catalog.jsonb_build_object('revisions',pg_catalog.jsonb_build_array(
   sentlog_delta_private.metadata_seed_revision(record_id,'geometry','{}'::jsonb))),
   'metaIdentity',pg_catalog.jsonb_build_object('revisions',pg_catalog.jsonb_build_array(
   sentlog_delta_private.metadata_seed_revision(record_id,'metaIdentity',identity))));
 IF kind='project' THEN
   value:=pg_catalog.jsonb_build_object('project',(metadata->'project')-ARRAY['id','drawings','updatedAt','collaborationVersion','deltaMetadata']);
 ELSE
   value:=pg_catalog.jsonb_build_object('meta',(metadata->'meta')-ARRAY['id','updatedAt','shapeCount','photoCount'],
     'state',(metadata->'state')-ARRAY['shapes','collabDeletedRecords','currentPage','width','height','pdfPageInfo','labelSize','nextGlobalNo','typeCounters'],
     'order',metadata->'order');
 END IF;
 FOR row IN SELECT f.* FROM pg_catalog.jsonb_each(value) roots CROSS JOIN LATERAL
   sentlog_delta_private.metadata_flatten(roots.value,pg_catalog.jsonb_build_array(roots.key)) f LOOP
   IF pg_catalog.jsonb_array_length(row.node->'path')>48 THEN RAISE EXCEPTION 'DELTA_METADATA_DEPTH' USING ERRCODE='22023'; END IF;
   field_keys:=pg_catalog.array_append(field_keys,row.field_key);
   field_values:=pg_catalog.array_append(field_values,pg_catalog.jsonb_build_object('revisions',pg_catalog.jsonb_build_array(
     sentlog_delta_private.metadata_seed_revision(record_id,row.field_key,row.node))));
 END LOOP;
 SELECT fields||coalesce(pg_catalog.jsonb_object_agg(field_keys[i],field_values[i] ORDER BY i),'{}'::jsonb) INTO fields
 FROM pg_catalog.generate_subscripts(field_keys,1) s(i);
 c:=pg_catalog.jsonb_build_object('version',1,'fields',fields,'comments','{}'::jsonb,'photos','{}'::jsonb,
   'deletion',pg_catalog.jsonb_build_object('revisions',pg_catalog.jsonb_build_array(
     (sentlog_delta_private.metadata_seed_revision(record_id,'@alive','null'::jsonb)-'value')||pg_catalog.jsonb_build_object('deleted',false,'observed','[]'::jsonb))),
   'projection',pg_catalog.jsonb_build_object('memo',''));
 RETURN (sentlog_delta_private.project_record(record_id,c))->'record';
END $fn$;

CREATE OR REPLACE FUNCTION sentlog_delta_private.seed_metadata_baseline(
 p_project_id uuid,p_device_id uuid,p_baseline_id uuid
) RETURNS jsonb LANGUAGE plpgsql SECURITY INVOKER SET search_path=''
AS $fn$
DECLARE u uuid; b sentlog_delta_private.baselines%ROWTYPE; local_id text; snapshot jsonb; envelope jsonb;
  documents jsonb:='{}'::jsonb; document_keys text[]:=ARRAY[]::text[]; document_values jsonb[]:=ARRAY[]::jsonb[]; doc jsonb; item record; state jsonb; existing jsonb; kept jsonb; bucket text; record jsonb; count_docs integer:=0;
BEGIN
 u:=sentlog_delta_private.baseline_authorize(p_project_id,p_device_id);
 SELECT * INTO b FROM sentlog_delta_private.baselines WHERE id=p_baseline_id AND project_id=p_project_id AND owner_id=u FOR UPDATE;
 IF NOT FOUND OR b.state<>'active' OR NOT EXISTS(SELECT 1 FROM sentlog_delta_private.heads WHERE project_id=p_project_id AND owner_id=u AND enabled) THEN
   RAISE EXCEPTION 'DELTA_METADATA_BASELINE_NOT_ACTIVE' USING ERRCODE='55000'; END IF;
 snapshot:=b.snapshot;local_id:=snapshot#>>'{project,id}';envelope:=snapshot#>'{project,deltaMetadata}';
 IF NOT EXISTS(SELECT 1 FROM public.sentlog_projects WHERE id=p_project_id AND owner_id=u AND client_key=local_id) THEN
   RAISE EXCEPTION 'DELTA_METADATA_BINDING_CHANGED' USING ERRCODE='40001'; END IF;
 IF EXISTS(SELECT 1 FROM sentlog_delta_private.record_states WHERE project_id=p_project_id AND drawing_id='@sentlog:metadata:v1') THEN
   FOR item IN SELECT record_id,collab FROM sentlog_delta_private.record_states WHERE project_id=p_project_id AND drawing_id='@sentlog:metadata:v1' LOOP
     doc:=sentlog_delta_private.materialize_metadata_document(item.record_id,item.collab);
     IF doc#>>'{identity,localProjectId}'<>local_id THEN RAISE EXCEPTION 'DELTA_METADATA_IDENTITY_INVALID' USING ERRCODE='22023'; END IF;
     count_docs:=count_docs+1;
   END LOOP;
   IF NOT EXISTS(SELECT 1 FROM sentlog_delta_private.record_states WHERE project_id=p_project_id AND drawing_id='@sentlog:metadata:v1' AND record_id='project') THEN
     RAISE EXCEPTION 'DELTA_METADATA_BASELINE_INCOMPLETE' USING ERRCODE='55000'; END IF;
   RETURN pg_catalog.jsonb_build_object('metadataCount',count_docs,'alreadySeeded',true);
 END IF;
 IF EXISTS(SELECT 1 FROM sentlog_delta_private.heads WHERE project_id=p_project_id AND last_seq<>0) THEN
   RAISE EXCEPTION 'DELTA_METADATA_BASELINE_STALE' USING ERRCODE='40001'; END IF;
 IF envelope IS NULL THEN
   doc:=sentlog_delta_private.seed_metadata_document('project',local_id,NULL,pg_catalog.jsonb_build_object('project',snapshot->'project'));
   document_keys:=ARRAY['project'];document_values:=ARRAY[doc];
   FOR item IN SELECT value,pos FROM pg_catalog.jsonb_array_elements(snapshot->'drawings') WITH ORDINALITY d(value,pos) LOOP
     doc:=sentlog_delta_private.seed_metadata_document('drawing',local_id,item.value#>>'{meta,id}',item.value||pg_catalog.jsonb_build_object('order',
       (SELECT p.pos-1 FROM pg_catalog.jsonb_array_elements(snapshot#>'{project,drawings}') WITH ORDINALITY p(value,pos) WHERE p.value->>'id'=item.value#>>'{meta,id}')));
     document_keys:=pg_catalog.array_append(document_keys,doc->>'id');
     document_values:=pg_catalog.array_append(document_values,doc);
   END LOOP;
   SELECT coalesce(pg_catalog.jsonb_object_agg(document_keys[i],document_values[i] ORDER BY i),'{}'::jsonb) INTO documents
   FROM pg_catalog.generate_subscripts(document_keys,1) s(i);
 ELSE
   IF envelope->'version' IS DISTINCT FROM '1'::jsonb OR envelope->>'namespace' IS DISTINCT FROM '@sentlog:metadata:v1' OR
     pg_catalog.jsonb_typeof(envelope->'records') IS DISTINCT FROM 'object' OR pg_catalog.jsonb_typeof(envelope->'retainedDrawings') IS DISTINCT FROM 'array' THEN
     RAISE EXCEPTION 'DELTA_METADATA_ENVELOPE_INVALID' USING ERRCODE='22023'; END IF;
   documents:=envelope->'records';
 END IF;
 PERFORM sentlog_delta_private.validate_metadata_snapshot(snapshot,documents);
 FOR item IN SELECT key,value FROM pg_catalog.jsonb_each(documents) LOOP
   IF item.key IS DISTINCT FROM item.value->>'id' THEN RAISE EXCEPTION 'DELTA_METADATA_IDENTITY_INVALID' USING ERRCODE='22023'; END IF;
   doc:=sentlog_delta_private.materialize_metadata_document(item.key,item.value->'collab');
   IF doc#>>'{identity,localProjectId}'<>local_id THEN RAISE EXCEPTION 'DELTA_METADATA_IDENTITY_INVALID' USING ERRCODE='22023'; END IF;
   INSERT INTO sentlog_delta_private.record_states(project_id,owner_id,drawing_id,record_id,collab,last_seq)
     VALUES(p_project_id,u,'@sentlog:metadata:v1',item.key,sentlog_delta_private.normalize_collab(item.value->'collab'),0);
   count_docs:=count_docs+1;
 END LOOP;
 IF NOT (documents ? 'project') THEN RAISE EXCEPTION 'DELTA_METADATA_BASELINE_INCOMPLETE' USING ERRCODE='22023'; END IF;
 FOR kept IN SELECT value FROM pg_catalog.jsonb_array_elements(coalesce(envelope->'retainedDrawings','[]'::jsonb)) LOOP
   IF NOT sentlog_delta_private.valid_id(kept#>'{meta,id}') OR NOT (documents ? ('drawing:'||sentlog_delta_private.metadata_hash(kept#>>'{meta,id}'))) THEN
     RAISE EXCEPTION 'DELTA_METADATA_RETAINED_INVALID' USING ERRCODE='22023'; END IF;
   FOREACH bucket IN ARRAY ARRAY['shapes','collabDeletedRecords'] LOOP
     FOR record IN SELECT value FROM pg_catalog.jsonb_array_elements(coalesce(kept#>ARRAY['state',bucket],'[]'::jsonb)) LOOP
       state:=sentlog_delta_private.project_record(record->>'id',record->'collab');
       SELECT collab INTO existing FROM sentlog_delta_private.record_states WHERE project_id=p_project_id AND drawing_id=kept#>>'{meta,id}' AND record_id=record->>'id';
       IF FOUND THEN
         IF existing IS DISTINCT FROM state#>'{record,collab}' THEN RAISE EXCEPTION 'DELTA_METADATA_RETAINED_COLLISION' USING ERRCODE='22023'; END IF;
       ELSE
         INSERT INTO sentlog_delta_private.record_states(project_id,owner_id,drawing_id,record_id,collab,last_seq)
           VALUES(p_project_id,u,kept#>>'{meta,id}',record->>'id',state#>'{record,collab}',0);
       END IF;
     END LOOP;
   END LOOP;
 END LOOP;
 RETURN pg_catalog.jsonb_build_object('metadataCount',count_docs,'alreadySeeded',false);
END $fn$;

CREATE OR REPLACE FUNCTION sentlog_delta_private.project_snapshot(pid uuid,local_project_id text,template jsonb)
RETURNS jsonb LANGUAGE plpgsql SECURITY INVOKER SET search_path=''
AS $fn$
DECLARE row_state record; drawing record; old_record jsonb; metadata jsonb; projected jsonb;
 project_data jsonb; documents jsonb:='{}'::jsonb; drawing_docs jsonb:='{}'::jsonb;
 document_keys text[]:=ARRAY[]::text[]; document_values jsonb[]:=ARRAY[]::jsonb[];
 -- Native arrays append without rebuilding every previous large drawing.
 visible_drawings jsonb[]:=ARRAY[]::jsonb[]; retained_drawings jsonb[]:=ARRAY[]::jsonb[]; drawing_metas jsonb[]:=ARRAY[]::jsonb[];
 meta jsonb; state jsonb; shapes jsonb[]; tombstones jsonb[]; counters jsonb; record_value jsonb;
 n bigint; type_count bigint; type_name text; photo_count bigint; any_live boolean; prior_drawings jsonb;
 prior_records jsonb; prior_positions jsonb; prior_drawing_index jsonb;
BEGIN
 IF pg_catalog.to_regprocedure('sentlog_delta_private.materialize_metadata_document(text,jsonb)') IS NULL THEN
   RAISE EXCEPTION 'DELTA_METADATA_PROJECTION_REQUIRED' USING ERRCODE='55000'; END IF;
 prior_drawings:=coalesce(template->'drawings','[]'::jsonb)||coalesce(template#>'{project,deltaMetadata,retainedDrawings}','[]'::jsonb);
 -- Select each source drawing once, retaining duplicate-source order exactly.
 -- Per-drawing record lookup no longer expands the full large snapshot again.
 SELECT coalesce(pg_catalog.jsonb_object_agg(g.drawing_id,g.items),'{}'::jsonb) INTO prior_drawing_index
 FROM (SELECT d.value#>>'{meta,id}' AS drawing_id,pg_catalog.jsonb_agg(d.value ORDER BY d.pos) AS items
       FROM pg_catalog.jsonb_array_elements(prior_drawings) WITH ORDINALITY d(value,pos)
       WHERE d.value#>>'{meta,id}' IS NOT NULL GROUP BY d.value#>>'{meta,id}') g;
 FOR row_state IN SELECT record_id,collab FROM sentlog_delta_private.record_states
   WHERE project_id=pid AND drawing_id='@sentlog:metadata:v1' ORDER BY record_id COLLATE "C" LOOP
   metadata:=sentlog_delta_private.materialize_metadata_document(row_state.record_id,row_state.collab);
   IF metadata#>>'{identity,localProjectId}' IS DISTINCT FROM local_project_id THEN
     RAISE EXCEPTION 'DELTA_METADATA_PROJECT_MISMATCH' USING ERRCODE='22023'; END IF;
   projected:=sentlog_delta_private.project_record(row_state.record_id,row_state.collab);
   document_keys:=pg_catalog.array_append(document_keys,row_state.record_id);
   document_values:=pg_catalog.array_append(document_values,projected->'record');
   IF metadata->>'kind'='project' THEN
     IF project_data IS NOT NULL OR row_state.record_id<>'project' OR metadata->'deleted'='true'::jsonb THEN
       RAISE EXCEPTION 'DELTA_METADATA_PROJECT_INVALID' USING ERRCODE='22023'; END IF;
     project_data:=metadata->'project';
   ELSIF metadata->>'kind'='drawing' THEN
     IF drawing_docs ? (metadata#>>'{identity,drawingId}') THEN
       RAISE EXCEPTION 'DELTA_METADATA_DRAWING_DUPLICATE' USING ERRCODE='22023'; END IF;
     drawing_docs:=drawing_docs||pg_catalog.jsonb_build_object(metadata#>>'{identity,drawingId}',metadata);
   ELSE RAISE EXCEPTION 'DELTA_METADATA_IDENTITY_INVALID' USING ERRCODE='22023'; END IF;
 END LOOP;
 IF project_data IS NULL OR jsonb_typeof(project_data) IS DISTINCT FROM 'object' THEN
   RAISE EXCEPTION 'DELTA_METADATA_BASELINE_REQUIRED' USING ERRCODE='55000'; END IF;
 IF EXISTS(SELECT 1 FROM sentlog_delta_private.record_states
   WHERE project_id=pid AND drawing_id<>'@sentlog:metadata:v1' AND NOT (drawing_docs ? drawing_id)) THEN
   RAISE EXCEPTION 'DELTA_CHECKPOINT_DRAWING_METADATA_MISSING' USING ERRCODE='55000'; END IF;
 FOR drawing IN SELECT key,value FROM pg_catalog.jsonb_each(drawing_docs)
   ORDER BY (value->>'order')::numeric NULLS LAST,key COLLATE "C" LOOP
   meta:=coalesce(drawing.value->'meta','{}'::jsonb)||pg_catalog.jsonb_build_object('id',drawing.key);
   state:=coalesce(drawing.value->'state','{}'::jsonb); shapes:=ARRAY[]::jsonb[]; tombstones:=ARRAY[]::jsonb[];
   counters:='{}'::jsonb;n:=0;photo_count:=0;any_live:=false;
   -- Index this drawing's prior records once. The previous correlated scan
   -- expanded every drawing and its shapes for each record being published.
   -- DISTINCT ON keeps the same first occurrence as the original LIMIT 1.
   SELECT coalesce(pg_catalog.jsonb_object_agg(x.record_id,x.value),'{}'::jsonb),
          coalesce(pg_catalog.jsonb_object_agg(x.record_id,x.pos),'{}'::jsonb)
     INTO prior_records,prior_positions FROM (
       SELECT DISTINCT ON (old.value->>'id') old.value->>'id' AS record_id,old.value,old.pos
       FROM pg_catalog.jsonb_array_elements(coalesce(prior_drawing_index->drawing.key,'[]'::jsonb)) WITH ORDINALITY d(value,drawing_pos)
       CROSS JOIN LATERAL pg_catalog.jsonb_array_elements(coalesce(d.value#>'{state,shapes}','[]'::jsonb)||
         coalesce(d.value#>'{state,collabDeletedRecords}','[]'::jsonb)) WITH ORDINALITY old(value,pos)
       WHERE d.value#>>'{meta,id}'=drawing.key AND old.value->>'id' IS NOT NULL
       ORDER BY old.value->>'id',d.drawing_pos,old.pos
     ) x;
   FOR row_state IN
     SELECT r.record_id,r.collab,prior_records->r.record_id AS prior_record
     FROM sentlog_delta_private.record_states r
     WHERE r.project_id=pid AND r.drawing_id=drawing.key
     ORDER BY (prior_positions->>r.record_id)::bigint NULLS LAST,r.record_id COLLATE "C"
   LOOP
     projected:=sentlog_delta_private.project_record(row_state.record_id,row_state.collab);record_value:=projected->'record';
     IF row_state.prior_record ? 'labelPosEditedAt' THEN
       record_value:=record_value||pg_catalog.jsonb_build_object('labelPosEditedAt',row_state.prior_record->'labelPosEditedAt'); END IF;
     IF projected->'deleted'='true'::jsonb THEN tombstones:=pg_catalog.array_append(tombstones,record_value);
     ELSE
       any_live:=true;
       IF coalesce(record_value->>'recordKind','') NOT IN ('drawing-memo','dimension-line') AND
          coalesce(record_value->>'kind','')<>'dimension' THEN
         type_name:=coalesce(nullif(record_value->>'type',''),'腐食');
         type_count:=coalesce((counters->>type_name)::bigint,0)+1;n:=n+1;
         counters:=counters||pg_catalog.jsonb_build_object(type_name,type_count);
         record_value:=record_value||pg_catalog.jsonb_build_object('globalNo',n,'typeNo',type_count,'autoLabel',type_name||'-'||type_count);
         IF record_value->>'recordKind'='field-record' THEN record_value:=record_value||pg_catalog.jsonb_build_object('recordNo',type_count); END IF;
       END IF;
       photo_count:=photo_count+pg_catalog.jsonb_array_length(record_value->'photos');
       shapes:=pg_catalog.array_append(shapes,record_value);
     END IF;
   END LOOP;
   state:=state||pg_catalog.jsonb_build_object('shapes',shapes,'collabDeletedRecords',tombstones,'nextGlobalNo',n+1,'typeCounters',counters);
   meta:=meta||pg_catalog.jsonb_build_object('shapeCount',n,'photoCount',photo_count);
   IF drawing.value->'deleted'='true'::jsonb AND NOT any_live THEN
     retained_drawings:=pg_catalog.array_append(retained_drawings,pg_catalog.jsonb_build_object('meta',meta,'state',state));
   ELSE
     drawing_metas:=pg_catalog.array_append(drawing_metas,meta);
     visible_drawings:=pg_catalog.array_append(visible_drawings,pg_catalog.jsonb_build_object('meta',meta,'state',state));
   END IF;
 END LOOP;
 SELECT coalesce(pg_catalog.jsonb_object_agg(document_keys[i],document_values[i] ORDER BY i),'{}'::jsonb) INTO documents
 FROM pg_catalog.generate_subscripts(document_keys,1) s(i);
 project_data:=project_data||pg_catalog.jsonb_build_object('id',local_project_id,'collaborationVersion',1,'drawings',drawing_metas,
   'deltaMetadata',pg_catalog.jsonb_build_object('version',1,'namespace','@sentlog:metadata:v1','records',documents,'retainedDrawings',retained_drawings));
 RETURN (coalesce(template,'{}'::jsonb)-'rawEntries')||pg_catalog.jsonb_build_object('project',project_data,'drawings',visible_drawings);
END $fn$;

-- PostgREST 14 hoists the setting of the OUTER exposed RPC before running its
-- main query. A SET inside a nested function would not reset an active native
-- statement timer. Only this one-time atomic cutover has the larger budget;
-- authenticated/anon roles, editing/checkpoint RPCs and lock_timeout stay as-is.
-- The client activation deadline is 45 s; the Data API upper limit is 60 s.
ALTER FUNCTION public.sentlog_delta_activate_baseline_v1(uuid,uuid,uuid,jsonb)
 SET statement_timeout='30s';
NOTIFY pgrst, 'reload schema';

COMMIT;

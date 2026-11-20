-- Immutable shared settings. Load after baseline and projection helpers.
-- Private functions only; activation is owned by the lifecycle transaction.
BEGIN;

CREATE OR REPLACE FUNCTION sentlog_delta_private.metadata_hash(value text)
RETURNS text LANGUAGE sql IMMUTABLE SECURITY INVOKER SET search_path=''
AS $fn$ SELECT pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(value,'UTF8')),'hex') $fn$;

CREATE OR REPLACE FUNCTION sentlog_delta_private.metadata_path_key(path jsonb)
RETURNS text LANGUAGE plpgsql IMMUTABLE SECURITY INVOKER SET search_path=''
AS $fn$
DECLARE result text;
BEGIN
 IF pg_catalog.jsonb_typeof(path) IS DISTINCT FROM 'array' OR EXISTS(
   SELECT 1 FROM pg_catalog.jsonb_array_elements(path) p(value) WHERE pg_catalog.jsonb_typeof(p.value)<>'string') THEN
   RAISE EXCEPTION 'DELTA_METADATA_PATH_INVALID' USING ERRCODE='22023'; END IF;
 SELECT coalesce(pg_catalog.string_agg(pg_catalog.octet_length(pg_catalog.convert_to(p.value,'UTF8'))::text||':'||p.value,'' ORDER BY p.pos),'')
   INTO result FROM pg_catalog.jsonb_array_elements_text(path) WITH ORDINALITY p(value,pos);
 RETURN result;
END $fn$;

CREATE OR REPLACE FUNCTION sentlog_delta_private.metadata_field_key(path jsonb)
RETURNS text LANGUAGE sql IMMUTABLE SECURITY INVOKER SET search_path=''
AS $fn$ SELECT 'm:'||sentlog_delta_private.metadata_hash(sentlog_delta_private.metadata_path_key(path)) $fn$;

CREATE OR REPLACE FUNCTION sentlog_delta_private.metadata_descendant(path jsonb,parent jsonb)
RETURNS boolean LANGUAGE sql IMMUTABLE SECURITY INVOKER SET search_path=''
AS $fn$
 SELECT pg_catalog.jsonb_array_length(path)>pg_catalog.jsonb_array_length(parent) AND NOT EXISTS(
   SELECT 1 FROM pg_catalog.jsonb_array_elements(parent) WITH ORDINALITY p(value,pos)
   WHERE path->(p.pos::integer-1) IS DISTINCT FROM p.value)
$fn$;

CREATE OR REPLACE FUNCTION sentlog_delta_private.metadata_flatten(value jsonb,path jsonb)
RETURNS TABLE(field_key text,node jsonb) LANGUAGE sql IMMUTABLE SECURITY INVOKER SET search_path=''
AS $fn$
 WITH RECURSIVE tree(value,path) AS (
   SELECT value,path
   UNION ALL
   SELECT child.value,t.path||pg_catalog.jsonb_build_array(child.key)
   FROM tree t CROSS JOIN LATERAL pg_catalog.jsonb_each(CASE WHEN pg_catalog.jsonb_typeof(t.value)='object' THEN t.value ELSE '{}'::jsonb END) child
 ) SELECT sentlog_delta_private.metadata_field_key(t.path),
   pg_catalog.jsonb_build_object('path',t.path,'type',CASE WHEN pg_catalog.jsonb_typeof(t.value)='object' THEN 'object' ELSE 'value' END)||
   CASE WHEN pg_catalog.jsonb_typeof(t.value)='object' THEN '{}'::jsonb ELSE pg_catalog.jsonb_build_object('value',t.value) END FROM tree t
$fn$;

CREATE OR REPLACE FUNCTION sentlog_delta_private.metadata_seed_revision(record_id text,field_key text,value jsonb)
RETURNS jsonb LANGUAGE sql IMMUTABLE SECURITY INVOKER SET search_path=''
AS $fn$
 SELECT pg_catalog.jsonb_build_object('id','metadata:seed:'||sentlog_delta_private.metadata_hash(
   sentlog_delta_private.metadata_path_key(pg_catalog.jsonb_build_array(record_id,field_key))),
   'parents','[]'::jsonb,'value',value,'actor',pg_catalog.jsonb_build_object('deviceId',NULL,'deviceName','不明'),'at',0)
$fn$;

CREATE OR REPLACE FUNCTION sentlog_delta_private.seed_metadata_document(
  kind text,local_project_id text,drawing_id text,metadata jsonb
) RETURNS jsonb LANGUAGE plpgsql SECURITY INVOKER SET search_path=''
AS $fn$
DECLARE record_id text; identity jsonb; fields jsonb; c jsonb; row record; value jsonb;
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
   fields:=fields||pg_catalog.jsonb_build_object(row.field_key,pg_catalog.jsonb_build_object('revisions',pg_catalog.jsonb_build_array(
     sentlog_delta_private.metadata_seed_revision(record_id,row.field_key,row.node))));
 END LOOP;
 c:=pg_catalog.jsonb_build_object('version',1,'fields',fields,'comments','{}'::jsonb,'photos','{}'::jsonb,
   'deletion',pg_catalog.jsonb_build_object('revisions',pg_catalog.jsonb_build_array(
     (sentlog_delta_private.metadata_seed_revision(record_id,'@alive','null'::jsonb)-'value')||pg_catalog.jsonb_build_object('deleted',false,'observed','[]'::jsonb))),
   'projection',pg_catalog.jsonb_build_object('memo',''));
 RETURN (sentlog_delta_private.project_record(record_id,c))->'record';
END $fn$;

-- Recursively reconstruct an object. A scalar/deletion is effective only for
-- descendant heads that its author actually observed. Unseen edits stay visible.
CREATE OR REPLACE FUNCTION sentlog_delta_private.build_metadata_node(
  nodes jsonb,path jsonb,record_id text,identity jsonb
) RETURNS jsonb LANGUAGE plpgsql SECURITY INVOKER SET search_path=''
AS $fn$
DECLARE item jsonb; node jsonb; child text; built jsonb; result jsonb:='{}'::jsonb;
  conflicts jsonb:='[]'::jsonb; unseen jsonb; children text[]; head_ids jsonb;
BEGIN
 item:=nodes->sentlog_delta_private.metadata_field_key(path);node:=item->'node';
 SELECT coalesce(pg_catalog.array_agg(name ORDER BY name COLLATE "C"),ARRAY[]::text[]) INTO children FROM (
   SELECT DISTINCT n.value->'path'->>pg_catalog.jsonb_array_length(path) AS name FROM pg_catalog.jsonb_each(nodes) n
   WHERE sentlog_delta_private.metadata_descendant(n.value->'path',path)) names;
 IF node IS NOT NULL AND node<>'null'::jsonb AND node->>'type'<>'object' THEN
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
   built:=sentlog_delta_private.build_metadata_node(nodes,path||pg_catalog.jsonb_build_array(child),record_id,identity);
   conflicts:=conflicts||(built->'conflicts');
   IF built->'present'='true'::jsonb THEN result:=result||pg_catalog.jsonb_build_object(child,built->'value'); END IF;
 END LOOP;
 RETURN pg_catalog.jsonb_build_object('present',true,'value',result,'conflicts',conflicts);
END $fn$;

CREATE OR REPLACE FUNCTION sentlog_delta_private.materialize_metadata_document(record_id text,collab jsonb)
RETURNS jsonb LANGUAGE plpgsql SECURITY INVOKER SET search_path=''
AS $fn$
DECLARE raw jsonb; identity jsonb; expected text; ent record; revision jsonb; node jsonb; path jsonb; first_path jsonb;
  reg jsonb; nodes jsonb:='{}'::jsonb; conflicts jsonb:='[]'::jsonb; result jsonb; built jsonb; root_name text; heads jsonb; common_heads jsonb;
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
   nodes:=nodes||pg_catalog.jsonb_build_object(ent.key,pg_catalog.jsonb_build_object('key',ent.key,'path',first_path,'reg',reg,'node',reg#>'{selected,value}'));
   IF reg->'conflict'='true'::jsonb THEN
     SELECT pg_catalog.jsonb_agg(h.value->'id' ORDER BY (h.value->>'id') COLLATE "C") INTO heads FROM pg_catalog.jsonb_array_elements(reg->'heads') h(value);
     SELECT coalesce(pg_catalog.jsonb_agg(h.value->'id' ORDER BY (h.value->>'id') COLLATE "C"),'[]'::jsonb) INTO common_heads FROM pg_catalog.jsonb_array_elements(reg->'commonHeads') h(value);
     conflicts:=conflicts||pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object('kind','metadata-field','recordId',record_id,
       'drawingId',identity->'drawingId','path',first_path,'key',ent.key,'headIds',heads,'candidates',reg->'heads','commonHeadIds',common_heads));
   END IF;
 END LOOP;
 result:=pg_catalog.jsonb_build_object('identity',identity,'kind',identity->'kind','deleted',raw->'deleted','pendingDelete',raw->'pendingDelete');
 FOREACH root_name IN ARRAY CASE WHEN identity->>'kind'='project' THEN ARRAY['project'] ELSE ARRAY['meta','state','order'] END LOOP
   IF NOT (nodes ? sentlog_delta_private.metadata_field_key(pg_catalog.jsonb_build_array(root_name))) THEN
     RAISE EXCEPTION 'DELTA_METADATA_ROOT_MISSING' USING ERRCODE='22023'; END IF;
   built:=sentlog_delta_private.build_metadata_node(nodes,pg_catalog.jsonb_build_array(root_name),record_id,identity);
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

-- The legacy display fields and the reserved history envelope must describe
-- the same shared metadata. Refuse an old client rewriting only the display.
CREATE OR REPLACE FUNCTION sentlog_delta_private.validate_metadata_snapshot(snapshot jsonb,documents jsonb)
RETURNS void LANGUAGE plpgsql SECURITY INVOKER SET search_path=''
AS $fn$
DECLARE entry record; doc jsonb; projected jsonb:='{}'::jsonb; source jsonb:='{}'::jsonb;
  local_id text:=snapshot#>>'{project,id}'; drawing jsonb; drawing_id text; seen text[]:=ARRAY[]::text[];
  listed text[]; actual text[]:=ARRAY[]::text[]; retained jsonb; record jsonb; visible boolean;
BEGIN
 IF NOT (documents ? 'project') OR pg_catalog.jsonb_typeof(snapshot#>'{project,drawings}') IS DISTINCT FROM 'array' OR
   pg_catalog.jsonb_typeof(snapshot->'drawings') IS DISTINCT FROM 'array' THEN
   RAISE EXCEPTION 'DELTA_METADATA_BASELINE_INCOMPLETE' USING ERRCODE='22023'; END IF;
 FOR entry IN SELECT key,value FROM pg_catalog.jsonb_each(documents) LOOP
   IF entry.key IS DISTINCT FROM entry.value->>'id' THEN RAISE EXCEPTION 'DELTA_METADATA_IDENTITY_INVALID' USING ERRCODE='22023'; END IF;
   doc:=sentlog_delta_private.materialize_metadata_document(entry.key,entry.value->'collab');
   IF doc#>>'{identity,localProjectId}' IS DISTINCT FROM local_id THEN RAISE EXCEPTION 'DELTA_METADATA_IDENTITY_INVALID' USING ERRCODE='22023'; END IF;
   IF entry.key='project' THEN
     IF doc->'deleted'='true'::jsonb OR doc->'pendingDelete'='true'::jsonb OR
       doc->'project' IS DISTINCT FROM (snapshot->'project')-ARRAY['id','drawings','updatedAt','collaborationVersion','deltaMetadata'] THEN
       RAISE EXCEPTION 'DELTA_METADATA_UNTRACKED' USING ERRCODE='22023'; END IF;
   ELSE projected:=projected||pg_catalog.jsonb_build_object(doc#>>'{identity,drawingId}',doc); END IF;
 END LOOP;
 SELECT coalesce(pg_catalog.array_agg(value->>'id' ORDER BY pos),ARRAY[]::text[]) INTO listed
   FROM pg_catalog.jsonb_array_elements(snapshot#>'{project,drawings}') WITH ORDINALITY p(value,pos);
 retained:=coalesce(snapshot#>'{project,deltaMetadata,retainedDrawings}','[]'::jsonb);
 IF pg_catalog.jsonb_typeof(retained) IS DISTINCT FROM 'array' THEN RAISE EXCEPTION 'DELTA_METADATA_ENVELOPE_INVALID' USING ERRCODE='22023'; END IF;
 FOR drawing IN SELECT value FROM pg_catalog.jsonb_array_elements((snapshot->'drawings')||retained) LOOP
   drawing_id:=drawing#>>'{meta,id}';doc:=projected->drawing_id;
   IF drawing_id IS NULL OR drawing_id=ANY(seen) OR doc IS NULL OR
     pg_catalog.jsonb_typeof(drawing->'meta') IS DISTINCT FROM 'object' OR pg_catalog.jsonb_typeof(drawing->'state') IS DISTINCT FROM 'object' OR
     pg_catalog.jsonb_typeof(drawing#>'{state,shapes}') IS DISTINCT FROM 'array' OR
     pg_catalog.jsonb_typeof(coalesce(drawing#>'{state,collabDeletedRecords}','[]'::jsonb)) IS DISTINCT FROM 'array' OR
     doc->'meta' IS DISTINCT FROM (drawing->'meta')-ARRAY['id','updatedAt','shapeCount','photoCount'] OR
     doc->'state' IS DISTINCT FROM (drawing->'state')-ARRAY['shapes','collabDeletedRecords','currentPage','width','height','pdfPageInfo','labelSize','nextGlobalNo','typeCounters'] THEN
     RAISE EXCEPTION 'DELTA_METADATA_UNTRACKED' USING ERRCODE='22023'; END IF;
   seen:=pg_catalog.array_append(seen,drawing_id);source:=source||pg_catalog.jsonb_build_object(drawing_id,drawing);
 END LOOP;
 IF pg_catalog.cardinality(seen)<>(SELECT count(*) FROM pg_catalog.jsonb_each(projected)) OR
   pg_catalog.jsonb_array_length(snapshot->'drawings')<>pg_catalog.cardinality(listed) THEN
   RAISE EXCEPTION 'DELTA_METADATA_BASELINE_INCOMPLETE' USING ERRCODE='22023'; END IF;
 FOR drawing IN SELECT value FROM pg_catalog.jsonb_array_elements(snapshot->'drawings') LOOP
   IF NOT EXISTS(SELECT 1 FROM pg_catalog.jsonb_array_elements(snapshot#>'{project,drawings}') p(value) WHERE p.value=drawing->'meta') THEN
     RAISE EXCEPTION 'DELTA_METADATA_DRAWINGS_MISMATCH' USING ERRCODE='22023'; END IF;
 END LOOP;
 FOR entry IN SELECT key,value FROM pg_catalog.jsonb_each(projected) ORDER BY (value->>'order')::numeric,key COLLATE "C" LOOP
   doc:=entry.value;drawing:=source->entry.key;visible:=doc->'deleted'<>'true'::jsonb OR doc->'pendingDelete'='true'::jsonb;
   FOR record IN SELECT value FROM pg_catalog.jsonb_array_elements((drawing#>'{state,shapes}')||coalesce(drawing#>'{state,collabDeletedRecords}','[]'::jsonb)) LOOP
     IF (sentlog_delta_private.project_record(record->>'id',record->'collab'))->'deleted'='false'::jsonb THEN visible:=true; END IF;
   END LOOP;
   IF visible THEN actual:=pg_catalog.array_append(actual,entry.key); END IF;
 END LOOP;
 IF actual IS DISTINCT FROM listed THEN RAISE EXCEPTION 'DELTA_METADATA_MEMBERSHIP_MISMATCH' USING ERRCODE='22023'; END IF;
END $fn$;

CREATE OR REPLACE FUNCTION sentlog_delta_private.seed_metadata_baseline(
 p_project_id uuid,p_device_id uuid,p_baseline_id uuid
) RETURNS jsonb LANGUAGE plpgsql SECURITY INVOKER SET search_path=''
AS $fn$
DECLARE u uuid; b sentlog_delta_private.baselines%ROWTYPE; local_id text; snapshot jsonb; envelope jsonb;
  documents jsonb:='{}'::jsonb; doc jsonb; item record; state jsonb; existing jsonb; kept jsonb; bucket text; record jsonb; count_docs integer:=0;
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
   documents:=pg_catalog.jsonb_build_object('project',doc);
   FOR item IN SELECT value,pos FROM pg_catalog.jsonb_array_elements(snapshot->'drawings') WITH ORDINALITY d(value,pos) LOOP
     doc:=sentlog_delta_private.seed_metadata_document('drawing',local_id,item.value#>>'{meta,id}',item.value||pg_catalog.jsonb_build_object('order',
       (SELECT p.pos-1 FROM pg_catalog.jsonb_array_elements(snapshot#>'{project,drawings}') WITH ORDINALITY p(value,pos) WHERE p.value->>'id'=item.value#>>'{meta,id}')));
     documents:=documents||pg_catalog.jsonb_build_object(doc->>'id',doc);
   END LOOP;
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

-- Validate the complete resulting document in the same transaction that
-- accepts its event. A malformed setting must never poison future checkpoints.
CREATE OR REPLACE FUNCTION sentlog_delta_private.validate_metadata_state()
RETURNS trigger LANGUAGE plpgsql SECURITY INVOKER SET search_path=''
AS $fn$
DECLARE doc jsonb; local_id text; owner uuid;
BEGIN
 IF NEW.drawing_id<>'@sentlog:metadata:v1' THEN RETURN NEW; END IF;
 SELECT client_key,owner_id INTO local_id,owner FROM public.sentlog_projects WHERE id=NEW.project_id FOR SHARE;
 doc:=sentlog_delta_private.materialize_metadata_document(NEW.record_id,NEW.collab);
 IF owner IS DISTINCT FROM NEW.owner_id OR doc#>>'{identity,localProjectId}' IS DISTINCT FROM local_id OR
   (doc->>'kind'='project' AND (doc->'deleted'='true'::jsonb OR doc->'pendingDelete'='true'::jsonb)) THEN
   RAISE EXCEPTION 'DELTA_METADATA_PROJECT_INVALID' USING ERRCODE='22023'; END IF;
 RETURN NEW;
END $fn$;
DROP TRIGGER IF EXISTS sentlog_validate_metadata_state ON sentlog_delta_private.record_states;
CREATE TRIGGER sentlog_validate_metadata_state BEFORE INSERT OR UPDATE ON sentlog_delta_private.record_states
 FOR EACH ROW EXECUTE FUNCTION sentlog_delta_private.validate_metadata_state();

-- Deferred validation allows an atomic operation to insert an ordinary record
-- before its new drawing document, while rejecting committed orphan records.
CREATE OR REPLACE FUNCTION sentlog_delta_private.validate_metadata_membership()
RETURNS trigger LANGUAGE plpgsql SECURITY INVOKER SET search_path=''
AS $fn$
DECLARE row record; doc jsonb;
BEGIN
 IF NOT EXISTS(SELECT 1 FROM sentlog_delta_private.record_states
   WHERE project_id=NEW.project_id AND drawing_id='@sentlog:metadata:v1' AND record_id='project') THEN RETURN NULL; END IF;
 FOR row IN SELECT DISTINCT drawing_id FROM sentlog_delta_private.record_states
   WHERE project_id=NEW.project_id AND drawing_id<>'@sentlog:metadata:v1' AND
    (NEW.drawing_id='@sentlog:metadata:v1' OR drawing_id=NEW.drawing_id) LOOP
   SELECT collab INTO doc FROM sentlog_delta_private.record_states WHERE project_id=NEW.project_id AND
     drawing_id='@sentlog:metadata:v1' AND record_id='drawing:'||sentlog_delta_private.metadata_hash(row.drawing_id);
   IF NOT FOUND OR doc#>>'{fields,metaIdentity,revisions,0,value,drawingId}' IS DISTINCT FROM row.drawing_id THEN
     RAISE EXCEPTION 'DELTA_METADATA_DRAWING_MISSING' USING ERRCODE='23514'; END IF;
 END LOOP;
 RETURN NULL;
END $fn$;
DROP TRIGGER IF EXISTS sentlog_validate_metadata_membership ON sentlog_delta_private.record_states;
CREATE CONSTRAINT TRIGGER sentlog_validate_metadata_membership AFTER INSERT OR UPDATE ON sentlog_delta_private.record_states
 DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION sentlog_delta_private.validate_metadata_membership();

REVOKE ALL ON FUNCTION sentlog_delta_private.metadata_hash(text),sentlog_delta_private.metadata_path_key(jsonb),
 sentlog_delta_private.metadata_field_key(jsonb),sentlog_delta_private.metadata_descendant(jsonb,jsonb),
 sentlog_delta_private.metadata_flatten(jsonb,jsonb),sentlog_delta_private.metadata_seed_revision(text,text,jsonb),
 sentlog_delta_private.seed_metadata_document(text,text,text,jsonb),sentlog_delta_private.build_metadata_node(jsonb,jsonb,text,jsonb),
 sentlog_delta_private.materialize_metadata_document(text,jsonb),sentlog_delta_private.validate_metadata_snapshot(jsonb,jsonb),
 sentlog_delta_private.seed_metadata_baseline(uuid,uuid,uuid),
 sentlog_delta_private.validate_metadata_state(),sentlog_delta_private.validate_metadata_membership()
 FROM PUBLIC,anon,authenticated;
COMMIT;

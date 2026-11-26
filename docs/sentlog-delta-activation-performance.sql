-- Reduce repeated deterministic projection work during baseline activation.
-- Existing graph validation, owner/device checks, row locks, immutable history,
-- checkpoint authority and transaction atomicity are unchanged. No data rows,
-- grants, role timeouts, rollout flags or project modes are changed on install.
BEGIN;

DO $activation_performance_preflight$
BEGIN
 IF pg_catalog.to_regprocedure('sentlog_delta_private.revision_heads(jsonb)') IS NULL OR
    pg_catalog.to_regprocedure('sentlog_delta_private.project_register(jsonb,text)') IS NULL OR
    pg_catalog.to_regprocedure('sentlog_delta_private.normalize_collab(jsonb)') IS NULL OR
    pg_catalog.to_regprocedure('sentlog_delta_private.project_record(text,jsonb)') IS NULL OR
    pg_catalog.to_regprocedure('sentlog_delta_private.project_snapshot(uuid,text,jsonb)') IS NULL OR
    pg_catalog.to_regprocedure('sentlog_delta_private.validate_metadata_snapshot(jsonb,jsonb)') IS NULL THEN
   RAISE EXCEPTION 'DELTA_ACTIVATION_PERFORMANCE_PREREQUISITE' USING ERRCODE='55000';
 END IF;
END $activation_performance_preflight$;

CREATE OR REPLACE FUNCTION sentlog_delta_private.revision_heads(entry jsonb)
RETURNS jsonb LANGUAGE plpgsql IMMUTABLE SECURITY INVOKER SET search_path=''
AS $fn$
DECLARE result jsonb;
BEGIN
 -- A sole root is its own unique head. This avoids re-running a correlated
 -- SQL graph scan for every untouched field, while all branched histories use
 -- the original head selection and all callers retain graph validation.
 IF pg_catalog.jsonb_array_length(entry->'revisions')=1 AND
    entry#>'{revisions,0,parents}'='[]'::jsonb THEN RETURN entry->'revisions'; END IF;
 SELECT coalesce(pg_catalog.jsonb_agg(r.value ORDER BY (r.value->>'id') COLLATE "C"),'[]'::jsonb) INTO result
 FROM pg_catalog.jsonb_array_elements(entry->'revisions') r(value)
 WHERE NOT EXISTS(SELECT 1 FROM pg_catalog.jsonb_array_elements(entry->'revisions') child(value)
   CROSS JOIN LATERAL pg_catalog.jsonb_array_elements_text(child.value->'parents') p(id)
   WHERE p.id=r.value->>'id');
 RETURN result;
END $fn$;

CREATE OR REPLACE FUNCTION sentlog_delta_private.project_register(entry jsonb,kind text)
RETURNS jsonb LANGUAGE plpgsql IMMUTABLE SECURITY INVOKER SET search_path=''
AS $fn$
DECLARE leaves jsonb; agreed jsonb; selected jsonb; differs boolean;
BEGIN
 IF kind NOT IN ('field','comment','photo') THEN
   RAISE EXCEPTION 'DELTA_PROJECTION_KIND_INVALID' USING ERRCODE='22023'; END IF;
 leaves:=sentlog_delta_private.revision_heads(entry);
 IF pg_catalog.jsonb_array_length(leaves)=0 THEN
   RAISE EXCEPTION 'DELTA_RECORD_HISTORY_MISSING' USING ERRCODE='22023'; END IF;
 -- One maximal revision has no conflict or ambiguous common ancestor.
 -- Graph validation still happens in project_record before this helper.
 IF pg_catalog.jsonb_array_length(leaves)=1 THEN
   RETURN pg_catalog.jsonb_build_object('heads',leaves,'conflict',false,
     'selected',leaves->0,'commonHeads',leaves);
 END IF;
 SELECT EXISTS(SELECT 1 FROM pg_catalog.jsonb_array_elements(leaves) h(value)
   WHERE sentlog_delta_private.revision_value(h.value,kind) IS DISTINCT FROM
         sentlog_delta_private.revision_value(leaves->0,kind)) INTO differs;
 IF NOT differs THEN agreed:=leaves;
 ELSE
   WITH RECURSIVE history AS (
     SELECT value AS revision,value->>'id' AS id FROM pg_catalog.jsonb_array_elements(entry->'revisions')
   ), edges(child,parent) AS (
     SELECT h.id,p.id FROM history h
     CROSS JOIN LATERAL pg_catalog.jsonb_array_elements_text(h.revision->'parents') p(id)
   ), ancestors(origin,id) AS (
     SELECT id,id FROM history
     UNION
     SELECT a.origin,e.parent FROM ancestors a JOIN edges e ON e.child=a.id
   ), shared AS (
     SELECT a.id FROM ancestors a JOIN pg_catalog.jsonb_array_elements(leaves) leaf(value)
       ON a.origin=leaf.value->>'id'
     GROUP BY a.id HAVING count(DISTINCT a.origin)=pg_catalog.jsonb_array_length(leaves)
   ), maximal AS (
     SELECT s.id FROM shared s WHERE NOT EXISTS(
       SELECT 1 FROM shared other JOIN ancestors a ON a.origin=other.id AND a.id=s.id
       WHERE other.id<>s.id)
   )
   SELECT coalesce(pg_catalog.jsonb_agg(h.revision ORDER BY h.id COLLATE "C"),'[]'::jsonb)
     INTO agreed FROM history h JOIN maximal m ON m.id=h.id;
 END IF;
 IF pg_catalog.jsonb_array_length(agreed)>0 AND NOT EXISTS(
   SELECT 1 FROM pg_catalog.jsonb_array_elements(agreed) a(value)
   WHERE sentlog_delta_private.revision_value(a.value,kind) IS DISTINCT FROM
         sentlog_delta_private.revision_value(agreed->0,kind)) THEN selected:=agreed->0;
 ELSE selected:=NULL; END IF;
 RETURN pg_catalog.jsonb_build_object('heads',leaves,'conflict',differs,
   'selected',selected,'commonHeads',agreed);
END $fn$;

CREATE OR REPLACE FUNCTION sentlog_delta_private.normalize_collab(c jsonb)
RETURNS jsonb LANGUAGE plpgsql IMMUTABLE SECURITY INVOKER SET search_path=''
AS $fn$
DECLARE out_state jsonb:=c; bucket jsonb; grp text; ent record;normalized jsonb;
BEGIN
 FOREACH grp IN ARRAY ARRAY['comments','fields','photos','deletion'] LOOP
   bucket:=CASE WHEN grp='deletion' THEN pg_catalog.jsonb_build_object('record',c->grp) ELSE c->grp END;
   FOR ent IN SELECT key,value FROM pg_catalog.jsonb_each(bucket) LOOP
     -- Row presentation order is deterministic; each immutable revision's
     -- payload (including legacy parents/observed array order) is unchanged.
     IF pg_catalog.jsonb_array_length(ent.value->'revisions')=1 THEN
       -- A singleton is already normalized; do not copy the complete record
       -- to replace an identical revisions array.
       CONTINUE;
     ELSE
       SELECT pg_catalog.jsonb_agg(value ORDER BY (value->>'id') COLLATE "C") INTO normalized
         FROM pg_catalog.jsonb_array_elements(ent.value->'revisions');
     END IF;
     out_state:=pg_catalog.jsonb_set(out_state,
       CASE WHEN grp='deletion' THEN ARRAY[grp,'revisions'] ELSE ARRAY[grp,ent.key,'revisions'] END,normalized);
   END LOOP;
 END LOOP;
 RETURN out_state;
END $fn$;

CREATE OR REPLACE FUNCTION sentlog_delta_private.project_record(record_id text,c jsonb)
RETURNS jsonb LANGUAGE plpgsql SECURITY INVOKER SET search_path=''
AS $fn$
DECLARE result jsonb:=pg_catalog.jsonb_build_object('id',record_id); normalized jsonb;
  ent record; reg jsonb; selected jsonb; live jsonb; metadata jsonb;
  comments text[]:=ARRAY[]::text[]; comment_text text; memo text;
  photos jsonb:='[]'::jsonb; decisions jsonb; live_ids jsonb:='[]'::jsonb;
  has_delete boolean; is_deleted boolean; grp text;
BEGIN
 IF NOT sentlog_delta_private.valid_id(pg_catalog.to_jsonb(record_id)) THEN
   RAISE EXCEPTION 'DELTA_PROJECTION_RECORD_ID_INVALID' USING ERRCODE='22023'; END IF;
 PERFORM sentlog_delta_private.validate_record_graph(c);
 normalized:=sentlog_delta_private.normalize_collab(c);
 FOR ent IN SELECT key,value FROM pg_catalog.jsonb_each(normalized->'fields') ORDER BY key COLLATE "C" LOOP
   reg:=sentlog_delta_private.project_register(ent.value,'field'); selected:=reg->'selected';
   IF selected IS NOT NULL AND selected<>'null'::jsonb AND selected->'unset' IS DISTINCT FROM 'true'::jsonb THEN
     IF ent.key='geometry' THEN result:=result||coalesce(selected->'value','{}'::jsonb);
     ELSE result:=result||pg_catalog.jsonb_build_object(ent.key,selected->'value'); END IF;
   END IF;
 END LOOP;
 FOR ent IN SELECT key,value FROM pg_catalog.jsonb_each(normalized->'comments')
   ORDER BY (value->>'order')::bigint,key COLLATE "C" LOOP
   live:=sentlog_delta_private.revision_heads(ent.value);
   IF EXISTS(SELECT 1 FROM pg_catalog.jsonb_array_elements(live) h(value) WHERE h.value->'deleted'='false'::jsonb) THEN
     SELECT pg_catalog.string_agg(t.body,E'\n\n' ORDER BY t.first_pos) INTO comment_text FROM (
       SELECT h.value->>'text' AS body,min(h.pos) AS first_pos
       FROM pg_catalog.jsonb_array_elements(live) WITH ORDINALITY h(value,pos)
       WHERE h.value->'deleted'='false'::jsonb GROUP BY h.value->>'text') t;
     comments:=pg_catalog.array_append(comments,coalesce(comment_text,''));
   END IF;
 END LOOP;
 memo:=pg_catalog.array_to_string(comments,E'\n\n');
 FOR ent IN SELECT key,value FROM pg_catalog.jsonb_each(normalized->'photos') ORDER BY key COLLATE "C" LOOP
   reg:=sentlog_delta_private.project_register(ent.value,'photo'); live:=reg->'heads'; selected:=reg->'selected';
   IF NOT EXISTS(SELECT 1 FROM pg_catalog.jsonb_array_elements(live) h(value)
       WHERE h.value->'deleted'='false'::jsonb) THEN CONTINUE; END IF;
   metadata:=NULL;
   IF selected IS NOT NULL AND selected<>'null'::jsonb AND selected->'deleted'='false'::jsonb THEN
     metadata:=selected->'value';
   ELSE
     SELECT h.value->'value' INTO metadata FROM pg_catalog.jsonb_array_elements(live) h(value)
       WHERE h.value->'deleted'='false'::jsonb LIMIT 1;
     IF EXISTS(SELECT 1 FROM pg_catalog.jsonb_array_elements(live) h(value)
       WHERE h.value->'deleted'='false'::jsonb AND h.value->'value' IS DISTINCT FROM metadata) THEN metadata:=NULL; END IF;
   END IF;
   photos:=photos||pg_catalog.jsonb_build_array(coalesce(metadata,
     pg_catalog.jsonb_build_object('id',ent.key,'name','写真（確認が必要）','collabConflict',true)));
 END LOOP;
 decisions:=sentlog_delta_private.revision_heads(normalized->'deletion');
 SELECT EXISTS(SELECT 1 FROM pg_catalog.jsonb_array_elements(decisions) h(value) WHERE h.value->'deleted'='true'::jsonb)
   INTO has_delete;
 -- Observed live heads affect only delete decisions. When every deletion
 -- head says alive, traversing every field/comment/photo again changes nothing.
 IF has_delete THEN
   FOREACH grp IN ARRAY ARRAY['comments','fields','photos'] LOOP
     FOR ent IN SELECT key,value FROM pg_catalog.jsonb_each(normalized->grp) LOOP
       SELECT live_ids||coalesce(pg_catalog.jsonb_agg(h.value->'id'),'[]'::jsonb) INTO live_ids
         FROM pg_catalog.jsonb_array_elements(sentlog_delta_private.revision_heads(ent.value)) h(value);
     END LOOP;
   END LOOP;
 END IF;
 is_deleted:=has_delete AND NOT EXISTS(SELECT 1 FROM pg_catalog.jsonb_array_elements(decisions) h(value)
   WHERE h.value->'deleted' IS DISTINCT FROM 'true'::jsonb OR EXISTS(
     SELECT 1 FROM pg_catalog.jsonb_array_elements_text(live_ids) l(id) WHERE NOT ((h.value->'observed') ? l.id)));
 result:=result||pg_catalog.jsonb_build_object('memo',memo,'photos',photos,
   'collab',pg_catalog.jsonb_set(normalized,'{projection}',pg_catalog.jsonb_build_object('memo',memo),true));
 RETURN pg_catalog.jsonb_build_object('record',result,'deleted',is_deleted,'pendingDelete',has_delete AND NOT is_deleted);
END $fn$;

CREATE OR REPLACE FUNCTION sentlog_delta_private.project_snapshot(pid uuid,local_project_id text,template jsonb)
RETURNS jsonb LANGUAGE plpgsql SECURITY INVOKER SET search_path=''
AS $fn$
DECLARE row_state record; drawing record; old_record jsonb; metadata jsonb; projected jsonb;
 project_data jsonb; documents jsonb:='{}'::jsonb; drawing_docs jsonb:='{}'::jsonb;
 -- Native arrays append without rebuilding every previous large drawing.
 visible_drawings jsonb[]:=ARRAY[]::jsonb[]; retained_drawings jsonb[]:=ARRAY[]::jsonb[]; drawing_metas jsonb[]:=ARRAY[]::jsonb[];
 meta jsonb; state jsonb; shapes jsonb; tombstones jsonb; counters jsonb; record_value jsonb;
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
   documents:=documents||pg_catalog.jsonb_build_object(row_state.record_id,projected->'record');
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
   state:=coalesce(drawing.value->'state','{}'::jsonb); shapes:='[]'::jsonb; tombstones:='[]'::jsonb;
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
     IF projected->'deleted'='true'::jsonb THEN tombstones:=tombstones||pg_catalog.jsonb_build_array(record_value);
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
       shapes:=shapes||pg_catalog.jsonb_build_array(record_value);
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
 project_data:=project_data||pg_catalog.jsonb_build_object('id',local_project_id,'collaborationVersion',1,'drawings',drawing_metas,
   'deltaMetadata',pg_catalog.jsonb_build_object('version',1,'namespace','@sentlog:metadata:v1','records',documents,'retainedDrawings',retained_drawings));
 RETURN (coalesce(template,'{}'::jsonb)-'rawEntries')||pg_catalog.jsonb_build_object('project',project_data,'drawings',visible_drawings);
END $fn$;

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
   seen:=pg_catalog.array_append(seen,drawing_id);
 END LOOP;
 -- The validated source map is built once; progressively concatenating it
 -- copied the complete growing project for each drawing during activation.
 SELECT coalesce(pg_catalog.jsonb_object_agg(d.value#>>'{meta,id}',d.value),'{}'::jsonb) INTO source
   FROM pg_catalog.jsonb_array_elements((snapshot->'drawings')||retained) d(value);
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
     -- Once metadata (or a prior record) already makes the drawing visible,
     -- projecting every other display field cannot change its membership.
     -- Still validate every immutable graph and record identity here. The
     -- atomic checkpoint projects every record in full before publication.
     IF visible THEN
       IF NOT sentlog_delta_private.valid_id(pg_catalog.to_jsonb(record->>'id')) THEN
         RAISE EXCEPTION 'DELTA_PROJECTION_RECORD_ID_INVALID' USING ERRCODE='22023'; END IF;
       PERFORM sentlog_delta_private.validate_record_graph(record->'collab');
     ELSIF (sentlog_delta_private.project_record(record->>'id',record->'collab'))->'deleted'='false'::jsonb THEN
       visible:=true;
     END IF;
   END LOOP;
   IF visible THEN actual:=pg_catalog.array_append(actual,entry.key); END IF;
 END LOOP;
 IF actual IS DISTINCT FROM listed THEN RAISE EXCEPTION 'DELTA_METADATA_MEMBERSHIP_MISMATCH' USING ERRCODE='22023'; END IF;
END $fn$;

COMMIT;

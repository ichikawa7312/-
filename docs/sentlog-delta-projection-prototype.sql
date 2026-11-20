-- Server-owned, deterministic projection of the accepted collaboration graph.
-- Load after semantic validation, before metadata/checkpoint integration.
-- No caller-supplied display fields are used to construct a certified snapshot.
BEGIN;

CREATE OR REPLACE FUNCTION sentlog_delta_private.revision_heads(entry jsonb)
RETURNS jsonb LANGUAGE sql IMMUTABLE SECURITY INVOKER SET search_path=''
AS $fn$
 SELECT coalesce(pg_catalog.jsonb_agg(r.value ORDER BY (r.value->>'id') COLLATE "C"),'[]'::jsonb)
 FROM pg_catalog.jsonb_array_elements(entry->'revisions') r(value)
 WHERE NOT EXISTS(SELECT 1 FROM pg_catalog.jsonb_array_elements(entry->'revisions') child(value)
   CROSS JOIN LATERAL pg_catalog.jsonb_array_elements_text(child.value->'parents') p(id)
   WHERE p.id=r.value->>'id')
$fn$;

CREATE OR REPLACE FUNCTION sentlog_delta_private.revision_value(revision jsonb,kind text)
RETURNS jsonb LANGUAGE sql IMMUTABLE SECURITY INVOKER SET search_path=''
AS $fn$
 SELECT CASE kind
   WHEN 'field' THEN CASE WHEN revision->'unset'='true'::jsonb
     THEN '{"unset":true}'::jsonb ELSE pg_catalog.jsonb_build_object('value',revision->'value') END
   WHEN 'comment' THEN pg_catalog.jsonb_build_object('text',revision->'text','deleted',revision->'deleted')
   WHEN 'photo' THEN pg_catalog.jsonb_build_object('value',revision->'value','deleted',revision->'deleted')
   ELSE NULL END
$fn$;

-- Concurrent different values display their unique agreed common ancestor.
-- Multiple different maximal common ancestors produce no selected value.
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
     SELECT pg_catalog.jsonb_agg(value ORDER BY (value->>'id') COLLATE "C") INTO normalized
       FROM pg_catalog.jsonb_array_elements(ent.value->'revisions');
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
 FOREACH grp IN ARRAY ARRAY['comments','fields','photos'] LOOP
   FOR ent IN SELECT key,value FROM pg_catalog.jsonb_each(normalized->grp) LOOP
     SELECT live_ids||coalesce(pg_catalog.jsonb_agg(h.value->'id'),'[]'::jsonb) INTO live_ids
       FROM pg_catalog.jsonb_array_elements(sentlog_delta_private.revision_heads(ent.value)) h(value);
   END LOOP;
 END LOOP;
 decisions:=sentlog_delta_private.revision_heads(normalized->'deletion');
 SELECT EXISTS(SELECT 1 FROM pg_catalog.jsonb_array_elements(decisions) h(value) WHERE h.value->'deleted'='true'::jsonb)
   INTO has_delete;
 is_deleted:=has_delete AND NOT EXISTS(SELECT 1 FROM pg_catalog.jsonb_array_elements(decisions) h(value)
   WHERE h.value->'deleted' IS DISTINCT FROM 'true'::jsonb OR EXISTS(
     SELECT 1 FROM pg_catalog.jsonb_array_elements_text(live_ids) l(id) WHERE NOT ((h.value->'observed') ? l.id)));
 result:=result||pg_catalog.jsonb_build_object('memo',memo,'photos',photos,
   'collab',pg_catalog.jsonb_set(normalized,'{projection}',pg_catalog.jsonb_build_object('memo',memo),true));
 RETURN pg_catalog.jsonb_build_object('record',result,'deleted',is_deleted,'pendingDelete',has_delete AND NOT is_deleted);
END $fn$;

REVOKE ALL ON FUNCTION sentlog_delta_private.revision_heads(jsonb),
  sentlog_delta_private.revision_value(jsonb,text),sentlog_delta_private.project_register(jsonb,text),
  sentlog_delta_private.normalize_collab(jsonb),sentlog_delta_private.project_record(text,jsonb)
  FROM PUBLIC,anon,authenticated;
COMMIT;

-- Local fixture for Supabase Realtime's authorization probe, not a live table.
CREATE TABLE realtime.messages(id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  extension text NOT NULL, topic text NOT NULL DEFAULT '', payload jsonb);
CREATE FUNCTION realtime.topic() RETURNS text LANGUAGE sql STABLE SECURITY INVOKER SET search_path=''
AS $$ SELECT nullif(pg_catalog.current_setting('test.realtime.topic',true),'') $$;
GRANT USAGE ON SCHEMA realtime TO authenticated,anon;
GRANT SELECT,INSERT ON realtime.messages TO authenticated,anon;
GRANT USAGE ON SEQUENCE realtime.messages_id_seq TO authenticated,anon;
-- Deliberately broad old policies test that the delta restrictions compose.
CREATE POLICY test_existing_broadcast_read ON realtime.messages FOR SELECT TO public USING(true);
CREATE POLICY test_existing_broadcast_send ON realtime.messages FOR INSERT TO public WITH CHECK(true);
INSERT INTO realtime.messages(extension,topic,payload) VALUES('broadcast','probe','{}'),('presence','probe','{}');

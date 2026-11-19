-- Local CI fixture only. No connection to any live Supabase project.
CREATE ROLE anon NOLOGIN;
CREATE ROLE authenticated NOLOGIN;
CREATE SCHEMA auth;
CREATE SCHEMA realtime;
CREATE TABLE auth.users (id uuid PRIMARY KEY);
CREATE FUNCTION auth.uid() RETURNS uuid
LANGUAGE sql STABLE SECURITY INVOKER SET search_path=''
AS $$
  SELECT pg_catalog.nullif(pg_catalog.current_setting('request.jwt.claim.sub',true),'')::uuid
$$;
CREATE TABLE public.sentlog_projects(
  id uuid PRIMARY KEY,
  owner_id uuid NOT NULL REFERENCES auth.users(id),
  status text NOT NULL
);
CREATE TABLE public.sentlog_devices(
  id uuid PRIMARY KEY,
  owner_id uuid NOT NULL REFERENCES auth.users(id),
  active boolean NOT NULL
);
CREATE TABLE public.sentlog_project_snapshots(
  project_id uuid PRIMARY KEY REFERENCES public.sentlog_projects(id),
  revision bigint NOT NULL DEFAULT 1
);
CREATE TABLE realtime.test_messages(
  id bigserial PRIMARY KEY,
  message jsonb NOT NULL,
  topic text NOT NULL
);
CREATE FUNCTION realtime.send(payload jsonb,event_name text,topic text,is_private boolean)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=''
AS $$
BEGIN
  INSERT INTO realtime.test_messages(message,topic)
    VALUES (pg_catalog.jsonb_build_object('payload',payload,'event',event_name,'private',is_private),topic);
END;
$$;
GRANT USAGE ON SCHEMA public,auth TO authenticated;
GRANT SELECT ON public.sentlog_projects,public.sentlog_devices TO authenticated;
GRANT SELECT ON public.sentlog_project_snapshots TO authenticated;
INSERT INTO auth.users(id) VALUES
 ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'),
 ('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb');
INSERT INTO public.sentlog_projects(id,owner_id,status) VALUES
 ('11111111-1111-4111-8111-111111111111','aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','active'),
 ('22222222-2222-4222-8222-222222222222','bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb','active'),
 ('33333333-3333-4333-8333-333333333333','aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','archived');
INSERT INTO public.sentlog_devices(id,owner_id,active) VALUES
 ('aaaaaaaa-0000-4000-8000-000000000001','aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',true),
 ('aaaaaaaa-0000-4000-8000-000000000002','aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',false),
 ('bbbbbbbb-0000-4000-8000-000000000003','bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',true);
INSERT INTO public.sentlog_project_snapshots(project_id,revision)
VALUES('11111111-1111-4111-8111-111111111111',3);

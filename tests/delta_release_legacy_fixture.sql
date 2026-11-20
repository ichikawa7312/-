-- Disposable platform/base-table fixture. The production archive, management,
-- registration, capacity, audit, collaboration and photo protocols are loaded
-- verbatim from db/ by delta_release_pglite.cjs, before the release is applied.
CREATE ROLE anon NOLOGIN;
CREATE ROLE authenticated NOLOGIN;
CREATE SCHEMA auth;
CREATE SCHEMA realtime;
CREATE SCHEMA storage;
CREATE SCHEMA extensions;
CREATE TABLE auth.users(id uuid PRIMARY KEY);
CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE SECURITY INVOKER SET search_path=''
AS $$ SELECT nullif(pg_catalog.current_setting('request.jwt.claim.sub',true),'')::uuid $$;
CREATE TABLE realtime.test_messages(id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,message jsonb NOT NULL,topic text NOT NULL);
CREATE FUNCTION realtime.send(payload jsonb,event_name text,topic text,is_private boolean)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=''
AS $$ BEGIN INSERT INTO realtime.test_messages(message,topic)
VALUES(pg_catalog.jsonb_build_object('payload',payload,'event',event_name,'private',is_private),topic); END $$;
CREATE TABLE realtime.messages(id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,extension text NOT NULL,topic text NOT NULL DEFAULT '',payload jsonb);
ALTER TABLE realtime.messages ENABLE ROW LEVEL SECURITY;
CREATE FUNCTION realtime.topic() RETURNS text LANGUAGE sql STABLE SECURITY INVOKER SET search_path=''
AS $$ SELECT nullif(pg_catalog.current_setting('test.realtime.topic',true),'') $$;
CREATE FUNCTION extensions.digest(value text,algorithm text) RETURNS bytea LANGUAGE plpgsql IMMUTABLE SET search_path=''
AS $$ BEGIN IF algorithm<>'sha256' THEN RAISE EXCEPTION 'Unsupported fixture digest';END IF;
RETURN pg_catalog.sha256(pg_catalog.convert_to(value,'UTF8'));END $$;
CREATE TABLE storage.objects(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),bucket_id text NOT NULL,name text NOT NULL,metadata jsonb NOT NULL DEFAULT '{}',UNIQUE(bucket_id,name));

CREATE TABLE public.sentlog_projects(
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),owner_id uuid NOT NULL REFERENCES auth.users(id),
 client_key text NOT NULL,name text NOT NULL DEFAULT '案件',status text NOT NULL DEFAULT 'active' CHECK(status IN ('active','archived')),
 created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now(),archived_at timestamptz,
 UNIQUE(owner_id,client_key));
CREATE TABLE public.sentlog_devices(
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),owner_id uuid NOT NULL REFERENCES auth.users(id),
 device_name text NOT NULL,device_type text NOT NULL CHECK(device_type IN ('iphone','ipad','browser','pc')),
 active boolean NOT NULL DEFAULT true,created_at timestamptz NOT NULL DEFAULT now(),last_seen_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE public.sentlog_project_snapshots(
 project_id uuid PRIMARY KEY REFERENCES public.sentlog_projects(id),owner_id uuid NOT NULL REFERENCES auth.users(id),
 revision bigint NOT NULL DEFAULT 1 CHECK(revision>0),payload jsonb NOT NULL,
 updated_by_device uuid REFERENCES public.sentlog_devices(id),updated_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE public.sentlog_assets(
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),project_id uuid NOT NULL REFERENCES public.sentlog_projects(id),owner_id uuid NOT NULL REFERENCES auth.users(id),
 client_key text NOT NULL,kind text NOT NULL CHECK(kind IN ('drawing','photo')),file_name text NOT NULL,mime_type text NOT NULL,
 byte_size bigint NOT NULL CHECK(byte_size>0),sha256 text NOT NULL CHECK(sha256~'^[0-9a-f]{64}$'),storage_path text NOT NULL,
 status text NOT NULL CHECK(status IN ('uploaded','pc_verified','storage_deleted')),metadata jsonb NOT NULL DEFAULT '{}',
 source_device_id uuid REFERENCES public.sentlog_devices(id),created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now(),
 uploaded_at timestamptz,pc_verified_at timestamptz,storage_deleted_at timestamptz,UNIQUE(project_id,client_key));
CREATE TABLE public.sentlog_pc_receipts(
 asset_id uuid PRIMARY KEY REFERENCES public.sentlog_assets(id),owner_id uuid NOT NULL REFERENCES auth.users(id),device_id uuid REFERENCES public.sentlog_devices(id),
 pc_path text NOT NULL,sha256 text NOT NULL,byte_size bigint NOT NULL,verified_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE public.sentlog_asset_device_receipts(
 asset_id uuid NOT NULL REFERENCES public.sentlog_assets(id),device_id uuid NOT NULL REFERENCES public.sentlog_devices(id),owner_id uuid NOT NULL REFERENCES auth.users(id),
 sha256 text NOT NULL,byte_size bigint NOT NULL,received_at timestamptz NOT NULL DEFAULT now(),PRIMARY KEY(asset_id,device_id));
CREATE TABLE public.sentlog_pdf_requests(
 asset_id uuid NOT NULL REFERENCES public.sentlog_assets(id),device_id uuid NOT NULL REFERENCES public.sentlog_devices(id),owner_id uuid NOT NULL REFERENCES auth.users(id),
 expected_sha256 text NOT NULL,requested_at timestamptz NOT NULL DEFAULT now(),received_at timestamptz,PRIMARY KEY(asset_id,device_id));
CREATE TABLE public.sentlog_pdf_leases(
 asset_id uuid PRIMARY KEY REFERENCES public.sentlog_assets(id),owner_id uuid NOT NULL REFERENCES auth.users(id),device_id uuid NOT NULL REFERENCES public.sentlog_devices(id),
 token uuid NOT NULL,storage_path text NOT NULL,expires_at timestamptz NOT NULL);
GRANT USAGE ON SCHEMA public,auth,realtime TO authenticated;
GRANT USAGE ON SCHEMA public,realtime TO anon;
GRANT SELECT,INSERT ON realtime.messages TO authenticated;
GRANT USAGE ON SEQUENCE realtime.messages_id_seq TO authenticated;
DO $policies$
DECLARE tab text;
BEGIN
 FOR tab IN SELECT unnest(ARRAY['sentlog_projects','sentlog_devices','sentlog_project_snapshots','sentlog_assets','sentlog_pc_receipts','sentlog_asset_device_receipts','sentlog_pdf_requests','sentlog_pdf_leases']) LOOP
  EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY',tab);
  EXECUTE format('CREATE POLICY fixture_owned ON public.%I TO authenticated USING(owner_id=(SELECT auth.uid())) WITH CHECK(owner_id=(SELECT auth.uid()))',tab);
  EXECUTE format('GRANT SELECT,INSERT,UPDATE,DELETE ON public.%I TO authenticated',tab);
 END LOOP;
END $policies$;

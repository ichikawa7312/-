-- Add only the columns/tables required to run the actual legacy archive SQL.
ALTER TABLE public.sentlog_projects ADD COLUMN IF NOT EXISTS name text DEFAULT 'synthetic';
ALTER TABLE public.sentlog_projects ADD COLUMN IF NOT EXISTS created_at timestamptz DEFAULT now();
ALTER TABLE public.sentlog_projects ADD COLUMN IF NOT EXISTS updated_at timestamptz DEFAULT now();
ALTER TABLE public.sentlog_projects ADD COLUMN IF NOT EXISTS archived_at timestamptz;
ALTER TABLE public.sentlog_devices ADD COLUMN IF NOT EXISTS device_name text DEFAULT 'synthetic';
ALTER TABLE public.sentlog_devices ADD COLUMN IF NOT EXISTS device_type text DEFAULT 'iphone';
ALTER TABLE public.sentlog_devices ADD COLUMN IF NOT EXISTS created_at timestamptz DEFAULT now();
ALTER TABLE public.sentlog_devices ADD COLUMN IF NOT EXISTS last_seen_at timestamptz DEFAULT now();
CREATE TABLE public.sentlog_assets(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),project_id uuid,owner_id uuid,
  client_key text,kind text,file_name text,mime_type text,byte_size bigint,sha256 text,storage_path text,status text);
CREATE TABLE public.sentlog_pc_receipts(asset_id uuid PRIMARY KEY,pc_path text);
CREATE SCHEMA IF NOT EXISTS extensions;
DO $fixture$
BEGIN
  IF to_regprocedure('extensions.digest(text,text)') IS NULL THEN
    EXECUTE $create$CREATE FUNCTION extensions.digest(value text,algorithm text) RETURNS bytea
      LANGUAGE sql IMMUTABLE AS 'SELECT pg_catalog.sha256(pg_catalog.convert_to(value,''UTF8''))'$create$;
  END IF;
END $fixture$;
INSERT INTO public.sentlog_devices(id,owner_id,active,device_name,device_type) VALUES
 ('aaaaaaaa-0000-4000-8000-000000000099','aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',true,'Synthetic PC','pc');
INSERT INTO public.sentlog_projects(id,owner_id,status,client_key) VALUES
 ('44444444-1111-4111-8111-111111111111','aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','active','frozen-delta'),
 ('44444444-2222-4222-8222-222222222222','aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','active','legacy-archive'),
 ('44444444-3333-4333-8333-333333333333','aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','active','new-delta');
INSERT INTO public.sentlog_project_snapshots(project_id,owner_id,revision,payload)
 SELECT id,owner_id,1,jsonb_build_object('project',jsonb_build_object('id',client_key,'name','保持する設定','drawings','[]'::jsonb,
   'custom',jsonb_build_object('scale',100,'note','unknown metadata survives')),'drawings','[]'::jsonb)
 FROM public.sentlog_projects WHERE id IN ('44444444-1111-4111-8111-111111111111','44444444-2222-4222-8222-222222222222','44444444-3333-4333-8333-333333333333');
INSERT INTO sentlog_delta_private.heads(project_id,owner_id,enabled,activated_at)
 SELECT id,owner_id,client_key<>'legacy-archive',CASE WHEN client_key<>'legacy-archive' THEN now() END
 FROM public.sentlog_projects WHERE id IN ('44444444-1111-4111-8111-111111111111','44444444-2222-4222-8222-222222222222','44444444-3333-4333-8333-333333333333');

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2";
const cors={"Access-Control-Allow-Origin":"*","Access-Control-Allow-Headers":"authorization, x-client-info, apikey, content-type","Access-Control-Allow-Methods":"POST, OPTIONS"};
const json=(body:unknown,status=200)=>new Response(JSON.stringify(body),{status,headers:{...cors,"content-type":"application/json; charset=utf-8"}});
Deno.serve(async(req:Request)=>{
  if(req.method==='OPTIONS')return new Response('ok',{headers:cors});
  if(req.method!=='POST')return json({error:'method_not_allowed'},405);
  const authorization=req.headers.get('Authorization');
  if(!authorization?.startsWith('Bearer '))return json({error:'auth_required'},401);
  const url=Deno.env.get('SUPABASE_URL')!,key=Deno.env.get('SUPABASE_ANON_KEY')!;
  const client=createClient(url,key,{global:{headers:{Authorization:authorization}},auth:{persistSession:false,autoRefreshToken:false}});
  const {data:identity,error:authError}=await client.auth.getUser();
  if(authError||!identity.user)return json({error:'invalid_session'},401);
  const body=await req.json().catch(()=>null);
  if(typeof body?.asset_id!=='string')return json({error:'asset_id_required'},400);
  const {data:asset,error:assetError}=await client.from('sentlog_assets').select('id,owner_id,project_id,kind,storage_path,status,storage_deleted_at,source_device_id,sha256,byte_size').eq('id',body.asset_id).single();
  if(assetError||!asset)return json({error:'asset_not_found'},404);
  if(asset.owner_id!==identity.user.id)return json({error:'forbidden'},403);
  if(asset.status==='storage_deleted'||asset.storage_deleted_at)return json({ok:true,already_deleted:true,asset_id:asset.id});
  if(asset.status!=='pc_verified')return json({error:'pc_verification_required'},409);
  // Active shared files remain independently downloadable even when every
  // source device is offline. Validate a matching PC receipt before reporting
  // the backup complete. This guard applies to old clients as well.
  if(asset.kind!=='drawing'&&asset.kind!=='photo')return json({error:'unsupported_asset_kind'},409);
  const {data:pc,error:pcError}=await client.from('sentlog_pc_receipts').select('sha256,byte_size,verified_at').eq('asset_id',asset.id).single();
  if(pcError||!pc||pc.sha256!==asset.sha256||Number(pc.byte_size)!==Number(asset.byte_size))return json({error:'matching_pc_receipt_required'},409);
  const {data:project,error:projectError}=await client.from('sentlog_projects').select('status').eq('id',asset.project_id).single();
  if(projectError||!project)return json({error:'project_status_check_failed'},500);
  // Retain both active and archived shared files while capacity allows.
  // Storage removal and DB status changes cannot form one transaction here.
  // Never remove shared bytes through this legacy endpoint; archive/reopen
  // may race, and a historical receipt is not proof of a current PC copy.
  if(!['active','archived'].includes(project.status))return json({error:'project_status_check_failed'},409);
  return json({ok:true,retained:true,asset_id:asset.id,reason:project.status==='archived'?'archived_project_retained':asset.kind==='drawing'?'active_project_drawing':'active_project_photo'});
});

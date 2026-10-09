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
  const {data:asset,error:assetError}=await client.from('sentlog_assets').select('id,owner_id,kind,storage_path,status,storage_deleted_at,source_device_id,sha256,byte_size').eq('id',body.asset_id).single();
  if(assetError||!asset)return json({error:'asset_not_found'},404);
  if(asset.owner_id!==identity.user.id)return json({error:'forbidden'},403);
  if(asset.status==='storage_deleted'||asset.storage_deleted_at)return json({ok:true,already_deleted:true,asset_id:asset.id});
  if(asset.status!=='pc_verified')return json({error:'pc_verification_required'},409);
  const {data:pc,error:pcError}=await client.from('sentlog_pc_receipts').select('sha256,byte_size,verified_at').eq('asset_id',asset.id).single();
  if(pcError||!pc||pc.sha256!==asset.sha256||Number(pc.byte_size)!==Number(asset.byte_size))return json({error:'matching_pc_receipt_required'},409);
  const admin=createClient(url,Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,{auth:{persistSession:false,autoRefreshToken:false}});
  if(asset.kind==='drawing'){
    // Requests survive app closure and offline periods. Do not expire the receiver out of this check.
    const {data:pending,error:pendingError}=await client.from('sentlog_pdf_requests').select('device_id').eq('asset_id',asset.id).eq('expected_sha256',asset.sha256).is('received_at',null);
    if(pendingError)return json({error:'pdf_delivery_check_failed'},500);
    if(pending?.length)return json({error:'pdf_delivery_pending',pending_device_count:pending.length},409);
    const {data:checked,error:checkedError}=await client.from('sentlog_asset_device_receipts').select('device_id').eq('asset_id',asset.id).eq('sha256',asset.sha256).eq('byte_size',asset.byte_size);
    if(checkedError)return json({error:'pdf_receipt_check_failed'},500);
    if(!(checked||[]).some((r:{device_id:string})=>r.device_id!==asset.source_device_id))return json({error:'pdf_verified_receiver_required'},409);
  }else if(asset.kind==='photo'){
    // PC-stored photographs are re-delivered to newly registered browsers.
    // Unlike original v5 (which checked only live iPad/iPhone receipts), do not
    // delete the temporary copy before requesting browser/PC clients can ACK it.
    // Stale abandoned InPrivate registrations stop blocking after 15 minutes,
    // and those clients can request the image again when reopened.
    const cutoff=Date.now()-15*60*1000;
    const {data:waiting,error:waitingError}=await admin.from('sentlog_pdf_requests')
      .select('device_id,requested_at')
      .eq('asset_id',asset.id).eq('owner_id',identity.user.id)
      .eq('expected_sha256',asset.sha256).is('received_at',null);
    if(waitingError)return json({error:'photo_delivery_check_failed'},500);
    const ids=[...new Set((waiting||[]).map((r:{device_id:string})=>r.device_id))];
    if(ids.length){
      const {data:waitingDevices,error:waitingDeviceError}=await admin.from('sentlog_devices')
        .select('id,last_seen_at').eq('owner_id',identity.user.id)
        .eq('active',true).in('id',ids);
      if(waitingDeviceError)return json({error:'photo_receiver_check_failed'},500);
      const byId=new Map((waitingDevices||[]).map((d:{id:string,last_seen_at:string})=>[d.id,d]));
      const pending=(waiting||[]).filter((r:{device_id:string,requested_at:string})=>{
        const d=byId.get(r.device_id);
        return d && (Date.parse(r.requested_at)>=cutoff || Date.parse(d.last_seen_at)>=cutoff);
      });
      if(pending.length)return json({error:'photo_delivery_pending',pending_device_count:pending.length},409);
    }
    const since=new Date(Date.now()-2*60*1000).toISOString();
    const {data:devices,error:deviceError}=await admin.from('sentlog_devices').select('id').eq('owner_id',identity.user.id).eq('active',true).in('device_type',['ipad','iphone']).gte('last_seen_at',since);
    if(deviceError)return json({error:'device_check_failed'},500);
    const required=(devices||[]).map((d:{id:string})=>d.id).filter((id:string)=>id!==asset.source_device_id);
    if(required.length){
      const {data:receipts,error:receiptError}=await admin.from('sentlog_asset_device_receipts').select('device_id').eq('asset_id',asset.id).in('device_id',required);
      if(receiptError)return json({error:'delivery_check_failed'},500);
      const have=new Set((receipts||[]).map((r:{device_id:string})=>r.device_id));
      const missing=required.filter((id:string)=>!have.has(id));
      if(missing.length)return json({error:'device_delivery_pending',pending_device_count:missing.length},409);
    }
  }else return json({error:'unsupported_asset_kind'},409);
  // Delete only the exact object checked above. A new delivery uses a different path.
  const {error:removeError}=await admin.storage.from('sentlog-temp').remove([asset.storage_path]);
  if(removeError)return json({error:'storage_delete_failed',detail:removeError.message},500);
  const now=new Date().toISOString();
  const {data:updated,error:updateError}=await admin.from('sentlog_assets').update({status:'storage_deleted',storage_deleted_at:now,updated_at:now}).eq('id',asset.id).eq('owner_id',identity.user.id).eq('storage_path',asset.storage_path).eq('sha256',asset.sha256).eq('status','pc_verified').select('id');
  if(updateError)return json({error:'metadata_update_failed'},500);
  if(!updated?.length)return json({error:'asset_changed_retry'},409);
  return json({ok:true,asset_id:asset.id,storage_deleted_at:now});
});

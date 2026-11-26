'use strict';
// JSON-lines adapter for built-browser tests. Every supported operation executes
// the real PostgreSQL functions/triggers in a disposable PGlite database.
// This process never accepts a database URL, SQL text, credentials or a network
// target, and is not a replacement server shipped with the application.
const fs=require('node:fs'),path=require('node:path');
const {PGlite}=require('@electric-sql/pglite');
const read=file=>fs.readFileSync(path.resolve(__dirname,'..',file),'utf8').replace(/^\\set[^\n]*$/mg,'');
const object=x=>x!==null&&typeof x==='object'&&!Array.isArray(x);
const own=(o,k)=>Object.prototype.hasOwnProperty.call(o,k);
const error=(code,message,status=400)=>Object.assign(Error(message),{code,status});
const shared=[['p_project_id','uuid'],['p_device_id','uuid']];
const page=[...shared,['p_after','bigint'],['p_limit','integer']];
const rpcArguments={
 sentlog_delta_inspect_v1:shared,sentlog_delta_capabilities_v1:shared,
 sentlog_delta_prepare_baseline_v1:[...shared,['p_expected_revision','bigint']],
 sentlog_delta_import_baseline_batch_v1:[...shared,['p_baseline_id','uuid'],['p_limit','integer']],
 sentlog_delta_read_baseline_page_v1:[...shared,['p_baseline_id','uuid'],['p_after','bigint'],['p_limit','integer']],
 sentlog_delta_read_baseline_metadata_page_v1:[...shared,['p_baseline_id','uuid'],['p_after','bigint'],['p_limit','integer']],
 sentlog_delta_activate_baseline_v1:[...shared,['p_baseline_id','uuid'],['p_proof','jsonb']],
 sentlog_delta_append_v1:[...shared,['p_event_id','text'],['p_drawing_id','text'],['p_record_id','text'],['p_envelope','jsonb']],
 sentlog_delta_append_group_v1:[...shared,['p_group','jsonb']],
 sentlog_delta_list_v1:page,sentlog_delta_list_groups_v1:page,
 sentlog_delta_publish_checkpoint_v1:[...shared,['p_expected_head','bigint'],['p_request_id','text']],
 sentlog_archive_v1:[['p_action','text'],...shared,['p_data','jsonb']],
 sentlog_capacity_v1:[['p_action','text'],...shared,['p_data','jsonb']],
 sentlog_management_v1:[['p_action','text'],...shared,['p_data','jsonb']],
 sentlog_device_registration_v1:[['p_action','text'],...shared,['p_data','jsonb']]
};
const tableNames=['sentlog_projects','sentlog_devices','sentlog_project_snapshots','sentlog_assets','sentlog_pc_receipts'];
function statusOf(e){if(e.status)return e.status;if(e.code==='42501')return 403;if(['28000','28P01'].includes(e.code))return 401;if(['40001','23505','55000'].includes(e.code))return 409;if(['42883','42P01','PGRST202'].includes(e.code))return 404;return /^22|^23/.test(e.code||'')?400:500;}
function parameters(request){
 const url=new URL(request.path||'/', 'https://synthetic.invalid');
 const query=new URLSearchParams(url.search);
 if(typeof request.query==='string')for(const [key,value]of new URLSearchParams(request.query))query.set(key,value);
 else for(const [key,input]of Object.entries(request.query||{}))for(const value of Array.isArray(input)?input:[input])query.set(key,String(value));
 return {pathname:url.pathname,query};
}

async function createBackend(){
 const db=new PGlite();let seedOwner=null;
 for(const file of ['tests/delta_schema_fixture.sql','docs/sentlog-delta-v1-schema-prototype.sql','docs/sentlog-delta-semantic-validation-prototype.sql',
  'tests/delta_baseline_fixture.sql','docs/sentlog-delta-baseline-prototype.sql','tests/delta_transport_fixture.sql','docs/sentlog-delta-transport-prototype.sql',
  'docs/sentlog-delta-atomic-groups-prototype.sql','tests/delta_archive_fixture.sql','db/archive_v1.sql',
  'db/management_v1.sql','db/device_registration_v1.sql','db/capacity_v1.sql','docs/sentlog-delta-archive-compat-prototype.sql',
  'docs/sentlog-delta-projection-prototype.sql','docs/sentlog-delta-metadata-prototype.sql'])await db.exec(read(file));
 await db.exec(`ALTER TABLE public.sentlog_project_snapshots ADD COLUMN updated_by_device uuid;
  ALTER TABLE public.sentlog_project_snapshots ADD COLUMN updated_at timestamptz DEFAULT now();
  ALTER TABLE public.sentlog_projects ADD COLUMN retired boolean NOT NULL DEFAULT false;
  ALTER TABLE public.sentlog_assets ADD COLUMN metadata jsonb DEFAULT '{}';
  ALTER TABLE public.sentlog_assets ADD COLUMN source_device_id uuid;
  ALTER TABLE public.sentlog_assets ADD COLUMN updated_at timestamptz DEFAULT now();
  GRANT SELECT,INSERT,UPDATE,DELETE ON public.sentlog_project_snapshots,public.sentlog_projects,public.sentlog_devices TO authenticated;
  GRANT SELECT ON public.sentlog_assets,public.sentlog_pc_receipts TO authenticated;`);
 for(const file of ['db/collaboration_v1.sql','docs/sentlog-delta-checkpoint-prototype.sql','docs/sentlog-delta-app-lifecycle.sql',
  'docs/sentlog-delta-activation-performance.sql','docs/sentlog-delta-activation-scalability.sql'])await db.exec(read(file));
 const columns={};for(const table of tableNames){columns[table]=new Map((await db.query("SELECT column_name,udt_name FROM information_schema.columns WHERE table_schema='public' AND table_name=$1",[table])).rows.map(r=>[r.column_name,r.udt_name]));}
 function column(table,key){if(!columns[table]?.has(key))throw error('PGRST204','Unsupported test column: '+key);return '"'+key+'"';}
 function selection(table,query){const select=query.get('select')||'*';if(select==='*')return '*';return select.split(',').map(k=>column(table,k)).join(',');}
 function filters(table,query,owner){
  const values=[owner],where=[table==='sentlog_pc_receipts'?'asset_id IN (SELECT id FROM public.sentlog_assets WHERE owner_id=$1::uuid)':'owner_id=$1::uuid'];
  for(const [key,input]of query){
   if(['select','order','limit','offset','on_conflict'].includes(key))continue;
   const col=column(table,key),dot=input.indexOf('.');if(dot<0)throw error('PGRST100','Unsupported test filter');
   const operator=input.slice(0,dot),raw=input.slice(dot+1),type=columns[table].get(key);
   if(operator==='is'&&raw==='null'){where.push(col+' IS NULL');continue;}
   if(operator==='in'){
    if(!raw.startsWith('(')||!raw.endsWith(')'))throw error('PGRST100','Invalid test IN filter');
    let items;try{items=raw.includes('"')?JSON.parse('['+raw.slice(1,-1)+']'):raw.slice(1,-1).split(',');}catch{throw error('PGRST100','Invalid test IN values');}
    if(!items.length){where.push('false');continue;}
    const slots=items.map(item=>{values.push(String(item));return '$'+values.length+'::'+type;});where.push(col+' IN ('+slots.join(',')+')');continue;
   }
   const operators={eq:'=',neq:'<>',gt:'>',gte:'>=',lt:'<',lte:'<='};
   if(!operators[operator])throw error('PGRST100','Unsupported test filter operator');
   // The real asset adapter quotes identity strings before URL encoding. Match
   // PostgREST's quoted scalar syntax rather than searching for literal quotes.
   let scalar=raw;
   if(raw.startsWith('"')){
    try{scalar=JSON.parse(raw);}catch{throw error('PGRST100','Invalid quoted test filter');}
    if(typeof scalar!=='string')throw error('PGRST100','Invalid quoted test filter');
   }
   values.push(scalar);where.push(col+operators[operator]+'$'+values.length+'::'+type);
  }
  return {where:where.join(' AND '),values};
 }
 async function withIdentity(owner,headers,fn){
  if(typeof owner!=='string'||!owner)throw error('28000','Authenticated synthetic owner required',401);
  await db.exec('BEGIN;SET LOCAL ROLE authenticated');
  try{
   const normalized=Object.fromEntries(Object.entries(headers||{}).map(([key,value])=>[key.toLowerCase(),String(value)]));
   await db.query("SELECT set_config('request.jwt.claim.sub',$1,true),set_config('request.headers',$2,true)",[owner,JSON.stringify(normalized)]);
   const result=await fn();await db.exec('COMMIT');return result;
  }catch(e){await db.exec('ROLLBACK');throw e;}
 }
 async function putAssets(owner,assets,sourceDevice){
  const accepted=[];
  for(const input of assets){
   if(!object(input))throw error('TEST_ASSET_INVALID','Asset object required');
   const pid=input.project_id||input.projectId,key=input.client_key||input.key,kind=input.kind;
   const sha=String(input.sha256||'').toLowerCase(),size=Number(input.byte_size??input.size);
   const mime=input.mime_type||input.mimeType||'application/pdf',status=input.status||'uploaded';
   if(!object(input)||input.owner_id&&input.owner_id!==owner||!['drawing','photo'].includes(kind)||typeof key!=='string'||!key.startsWith(kind+':')||
     !/^[0-9a-f]{64}$/.test(sha)||!Number.isSafeInteger(size)||size<=0||
     !['application/pdf','image/jpeg','image/png','image/webp','image/heic','image/heif',...(kind==='drawing'?['image/svg+xml']:[])].includes(mime)||
     !['uploaded','pc_verified','storage_deleted'].includes(status)||
     !(await db.query('SELECT 1 FROM public.sentlog_projects WHERE id=$1 AND owner_id=$2',[pid,owner])).rows.length)
    throw error('TEST_ASSET_INVALID','Synthetic asset must match an owned project and complete immutable bytes');
   const existing=(await db.query('SELECT * FROM public.sentlog_assets WHERE id=$1::uuid OR (project_id=$2 AND client_key=$3)',[input.id||null,pid,key])).rows;
   if(existing.length>1||existing.some(a=>a.owner_id!==owner||a.project_id!==pid||a.client_key!==key||a.kind!==kind||a.sha256.toLowerCase()!==sha||Number(a.byte_size)!==size||input.id&&input.id!==a.id))
    throw error('TEST_ASSET_COLLISION','Synthetic asset identity/content cannot be overwritten');
   const id=input.id||existing[0]?.id||require('node:crypto').randomUUID();
   const row=(await db.query(`INSERT INTO public.sentlog_assets(id,project_id,owner_id,client_key,kind,file_name,mime_type,byte_size,sha256,storage_path,status,metadata,source_device_id)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12::jsonb,$13)
    ON CONFLICT(id) DO UPDATE SET file_name=EXCLUDED.file_name,mime_type=EXCLUDED.mime_type,storage_path=EXCLUDED.storage_path,
      status=EXCLUDED.status,metadata=EXCLUDED.metadata,source_device_id=EXCLUDED.source_device_id,updated_at=now() RETURNING *`,
    [id,pid,owner,key,kind,input.file_name||input.name||'synthetic',mime,size,sha,input.storage_path||'synthetic/'+id,status,
     JSON.stringify(input.metadata||{}),input.source_device_id||sourceDevice||null])).rows[0];accepted.push(row);
  }
  return accepted;
 }
 async function seed(input){
  const owner=input.ownerId;if(typeof owner!=='string')throw error('TEST_SEED','ownerId is required');
  await db.exec('BEGIN');
  try{
   await db.query('INSERT INTO auth.users(id) VALUES($1) ON CONFLICT DO NOTHING',[owner]);
   await db.query("SELECT set_config('request.jwt.claim.sub',$1,true),set_config('request.headers',$2,true)",[owner,JSON.stringify({'x-client-info':'sentlog-collaboration/1'})]);
   for(const device of input.devices||[])await db.query(`INSERT INTO public.sentlog_devices(id,owner_id,active,device_name,device_type)
    VALUES($1,$2,$3,$4,$5) ON CONFLICT(id) DO UPDATE SET active=EXCLUDED.active,device_name=EXCLUDED.device_name,device_type=EXCLUDED.device_type
    WHERE public.sentlog_devices.owner_id=EXCLUDED.owner_id`,[device.id,owner,device.active!==false,device.name||device.device_name||'Synthetic phone',device.type||device.device_type||'iphone']);
   for(const project of input.projects||[]){
    const clientKey=project.client_key||project.payload?.project?.id;
    await db.query("INSERT INTO public.sentlog_projects(id,owner_id,status,client_key,name) VALUES($1,$2,'active',$3,$4)",[project.id,owner,clientKey,project.name||project.payload?.project?.name||'Synthetic project']);
    if(project.payload)await db.query('INSERT INTO public.sentlog_project_snapshots(project_id,owner_id,revision,payload,updated_by_device) VALUES($1,$2,$3,$4::jsonb,$5)',[project.id,owner,project.revision||1,JSON.stringify(project.payload),project.updated_by_device||input.devices?.[0]?.id]);
   }
   await putAssets(owner,input.assets||[],input.devices?.[0]?.id);
   await db.query('INSERT INTO sentlog_delta_private.rollouts(owner_id,enabled) VALUES($1,$2) ON CONFLICT(owner_id) DO UPDATE SET enabled=EXCLUDED.enabled',[owner,input.rollout===true]);
   await db.exec('COMMIT');seedOwner=owner;return {seeded:true,projects:(input.projects||[]).map(p=>p.id)};
  }catch(e){await db.exec('ROLLBACK');throw e;}
 }
 async function request(input){
  const {pathname,query}=parameters(input),method=String(input.method||'GET').toUpperCase();
  let body=input.body;if(typeof body==='string'){try{body=JSON.parse(body);}catch{throw error('PGRST102','Invalid JSON body');}}
  return withIdentity(input.ownerId,input.headers,async()=>{
   if(pathname.startsWith('/rest/v1/rpc/')){
    if(method!=='POST')throw error('PGRST101','RPC requires POST',405);
    const name=pathname.slice('/rest/v1/rpc/'.length),spec=rpcArguments[name];
    if(!spec||!object(body))throw error('PGRST202','Unsupported test RPC',404);
    if(Object.keys(body).some(key=>!spec.some(([allowed])=>allowed===key)))throw error('PGRST202','Unknown named RPC argument',404);
    const args=[],sqlArgs=[];for(const [key,type]of spec)if(own(body,key)){args.push(type==='jsonb'?JSON.stringify(body[key]):body[key]);sqlArgs.push(key+'=> $'+args.length+'::'+type);}
    return (await db.query('SELECT public.'+name+'('+sqlArgs.join(',')+') AS result',args)).rows[0].result;
   }
   const table=pathname.replace(/^\/rest\/v1\//,'');if(!tableNames.includes(table))throw error('PGRST205','Unsupported test table',404);
   const selected=selection(table,query),filtered=filters(table,query,input.ownerId);
   if(method==='GET'){
    let suffix='';if(query.has('order'))suffix+=' ORDER BY '+query.get('order').split(',').map(item=>{const [key,direction='asc']=item.split('.');if(!['asc','desc'].includes(direction))throw error('PGRST100','Invalid test ordering');return column(table,key)+' '+direction;}).join(',');
    for(const key of ['limit','offset'])if(query.has(key)){const n=Number(query.get(key));if(!Number.isSafeInteger(n)||n<0||n>10000)throw error('PGRST100','Invalid test page size');suffix+=' '+key.toUpperCase()+' '+n;}
    return (await db.query('SELECT '+selected+' FROM public.'+table+' WHERE '+filtered.where+suffix,filtered.values)).rows;
   }
   if(!['sentlog_projects','sentlog_devices','sentlog_project_snapshots'].includes(table)||!['POST','PATCH'].includes(method))throw error('42501','Unsupported test mutation',403);
   if(method==='PATCH'){
    if(!object(body)||!Object.keys(body).length)throw error('PGRST102','Patch object required');
    if(own(body,'owner_id')&&body.owner_id!==input.ownerId)throw error('42501','Owner cannot change',403);
    const values=[...filtered.values],sets=Object.entries(body).map(([key,value])=>{const col=column(table,key),type=columns[table].get(key);values.push(type==='jsonb'?JSON.stringify(value):value);return col+'=$'+values.length+'::'+type;});
    return (await db.query('UPDATE public.'+table+' SET '+sets.join(',')+' WHERE '+filtered.where+' RETURNING '+selected,values)).rows;
   }
   const rows=Array.isArray(body)?body:[body],result=[];
   for(const inputRow of rows){
    if(!object(inputRow)||inputRow.owner_id!==input.ownerId)throw error('42501','Insert owner must match authenticated owner',403);
    const row={...inputRow};if(table!=='sentlog_project_snapshots'&&!row.id)row.id=require('node:crypto').randomUUID();
    const fields=Object.keys(row),values=fields.map(key=>columns[table].get(key)==='jsonb'?JSON.stringify(row[key]):row[key]);
    let sql='INSERT INTO public.'+table+'('+fields.map(k=>column(table,k)).join(',')+') VALUES('+fields.map((key,i)=>'$'+(i+1)+'::'+columns[table].get(key)).join(',')+')';
    const prefer=String(input.headers?.Prefer||input.headers?.prefer||'');
    if(query.get('on_conflict')==='project_id'&&table==='sentlog_project_snapshots'&&prefer.includes('resolution=merge-duplicates'))sql+=' ON CONFLICT(project_id) DO UPDATE SET '+fields.filter(k=>k!=='project_id').map(k=>column(table,k)+'=EXCLUDED.'+column(table,k)).join(',');
    result.push(...(await db.query(sql+' RETURNING '+selected,values)).rows);
   }
   return result;
  });
 }
 async function state(input={}){
  const owner=input.ownerId||seedOwner,project=input.projectId||input.project_id||null;if(!owner)throw error('TEST_STATE','Seed owner or ownerId required');
  const result={};
  for(const [name,table,column]of [['projects','public.sentlog_projects','id'],['snapshots','public.sentlog_project_snapshots','project_id'],
   ['heads','sentlog_delta_private.heads','project_id'],['events','public.sentlog_delta_events','project_id'],['eventGroups','sentlog_delta_private.event_groups','project_id'],
   ['recordStates','sentlog_delta_private.record_states','project_id'],['baselines','sentlog_delta_private.baselines','project_id'],
   ['checkpoints','sentlog_delta_private.checkpoints','project_id'],['jobs','sentlog_archive_private.jobs','project_id'],['deviceMigrations','sentlog_delta_private.device_migrations','project_id']]){
   result[name]=(await db.query('SELECT * FROM '+table+' WHERE owner_id=$1'+(project?' AND '+column+'=$2':''),project?[owner,project]:[owner])).rows;
  }
  result.counts=Object.fromEntries(Object.entries(result).map(([key,rows])=>[key,rows.length]));return result;
 }
 async function admin(input){
  const owner=input.ownerId||seedOwner;if(!owner)throw error('TEST_ADMIN','ownerId is required');
  switch(input.action){
   case 'state':return state(input);
   case 'rollout':await db.query('UPDATE sentlog_delta_private.rollouts SET enabled=$2 WHERE owner_id=$1',[owner,input.enabled===true]);return {updated:true};
   case 'device_active':await db.query('UPDATE public.sentlog_devices SET active=$3 WHERE owner_id=$1 AND id=$2',[owner,input.deviceId,input.active===true]);return {updated:true};
   case 'archive_expire':await db.query("UPDATE sentlog_archive_private.jobs SET expires_at=now()-interval '1 second' WHERE owner_id=$1 AND project_id=$2 AND state='checking'",[owner,input.projectId]);return {updated:true};
   case 'assets':{
    if(!Array.isArray(input.assets))throw error('TEST_ASSET_INVALID','assets array required');
    await db.exec('BEGIN');try{
     await db.query("SELECT set_config('request.jwt.claim.sub',$1,true)",[owner]);
     const assets=await putAssets(owner,input.assets,input.deviceId);await db.exec('COMMIT');return {assets};
    }catch(e){await db.exec('ROLLBACK');throw e;}
   }
   default:throw error('TEST_ADMIN','Unsupported synthetic admin operation');
  }
 }
 return {seed,request,state,admin,close:()=>db.close(),async dispatch(command){
  if(!object(command))throw error('TEST_COMMAND','JSON object required');
  const op=command.op||command.type,input=command.args??command.data??command;
  if(op==='seed')return seed(input);if(op==='request')return request(input);if(op==='state')return state(input);if(op==='admin')return admin(input);
  throw error('TEST_COMMAND','Unsupported synthetic command');
 }};
}

async function main(){
 const backend=await createBackend();process.stdout.write(JSON.stringify({ready:true})+'\n');
 const lines=require('node:readline').createInterface({input:process.stdin,crlfDelay:Infinity});
 try{for await(const line of lines){if(!line.trim())continue;let command,response;
  try{command=JSON.parse(line);response={ok:true,data:await backend.dispatch(command),status:200};}
  catch(e){response={ok:false,error:{code:e.code||'TEST_ERROR',message:e.message},status:statusOf(e)};}
  if(command&&own(command,'id'))response.id=command.id;
  process.stdout.write(JSON.stringify(response)+'\n');
 }}finally{await backend.close();}
}
module.exports={createBackend,statusOf};
if(require.main===module)main().catch(e=>{process.stderr.write(JSON.stringify({code:e.code,message:e.message})+'\n');process.exitCode=1;});

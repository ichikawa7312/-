/* Start the managed Realtime tenant using one empty, unique public channel.
 * No user token, application message, presence, or database subscription is used.
 * Supabase creates its managed message partitions on the first channel join:
 * https://supabase.com/kb/troubleshooting/realtime-warn-sending-broadcast-message
 */
const fs=require('node:fs');
const path=require('node:path');
const {randomUUID}=require('node:crypto');
const source=fs.readFileSync(path.join(__dirname,'../sentlog/cloud-sync.js'),'utf8');
const url=source.match(/const SUPABASE_URL='([^']+)'/)[1];
const key=source.match(/const SUPABASE_KEY='([^']+)'/)[1];
const topic='realtime:sentlog-init-'+randomUUID();
const socket=new WebSocket(url.replace(/^http/,'ws')+'/realtime/v1/websocket?apikey='+encodeURIComponent(key)+'&vsn=1.0.0');
let settled=false,joined=false,ready=false;
const timeout=setTimeout(()=>finish(new Error('Realtime channel join timed out')),20000);
function finish(error){
  if(settled)return;settled=true;clearTimeout(timeout);
  if(socket.readyState===1)socket.send(JSON.stringify({topic,event:'phx_leave',ref:'2',join_ref:'1',payload:{}}));
  socket.close();
  if(error){console.error(error.message);process.exitCode=1;}
  else console.log('PASS managed Realtime: unique empty public channel joined and replication ready; no application data sent or subscribed');
}
socket.onopen=()=>socket.send(JSON.stringify({topic,event:'phx_join',ref:'1',join_ref:'1',payload:{config:{private:false,broadcast:{ack:false,self:false,replication_ready:true},presence:{enabled:false},postgres_changes:[]}}}));
socket.onmessage=event=>{
  let value;try{value=JSON.parse(event.data);}catch(_){return;}
  if(value.topic!==topic)return;
  if(value.event==='phx_reply'&&value.ref==='1'){
    if(value.payload?.status!=='ok')return finish(new Error('Realtime public probe was rejected; project authorization settings were not changed'));
    joined=true;
  }
  if(value.event==='system'&&value.payload?.extension==='system'){
    if(value.payload.status!=='ok')return finish(new Error('Realtime replication could not become ready'));
    ready=value.payload.message==='Replication connection established';
  }
  if(joined&&ready)finish();
};
socket.onerror=()=>finish(new Error('Realtime probe connection failed'));
socket.onclose=()=>{if(!settled)finish(new Error('Realtime connection closed before the channel joined'));};

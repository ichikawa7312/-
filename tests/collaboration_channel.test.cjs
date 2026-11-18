const assert=require('node:assert/strict');
const {create}=require('../sentlog/collaboration-channel.js');
const a='11111111-1111-4111-8111-111111111111',b='22222222-2222-4222-8222-222222222222';
let account={user:{id:a},access_token:'test-token-a'},online=true,nextTimer=0;
const timers=new Map(),sockets=[],changes=[];let ready=0;
class Socket{
  constructor(url){this.url=url;this.readyState=0;this.sent=[];sockets.push(this);}
  open(){this.readyState=1;this.onopen();}
  send(s){this.sent.push(JSON.parse(s));}
  close(){this.readyState=3;}
  emit(value){this.onmessage?.({data:JSON.stringify(value)});}
}
const channel=create({url:'https://example.supabase.co',key:'public-test-key',session:()=>account,
  enabled:()=>online,onChange:x=>changes.push(x),onReady:()=>ready++,Socket,
  setTimer:(f,ms)=>{timers.set(++nextTimer,{f,ms});return nextTimer;},clearTimer:id=>timers.delete(id),random:()=>.5});
channel.wake();let first=sockets[0];assert(!first.url.includes('test-token'));
first.open();let join=first.sent[0];assert.equal(join.payload.config.private,true);
assert.equal(join.payload.access_token,'test-token-a');assert.equal(join.payload.config.presence.enabled,false);
const ack=s=>{const j=s.sent.find(x=>x.event==='phx_join');s.emit({topic:j.topic,event:'phx_reply',ref:j.ref,join_ref:j.ref,payload:{status:'ok'}});};
ack(first);assert.equal(channel.connected,true);assert.equal(ready,1);
const notify=(s,project_id,revision,kind='records')=>s.emit({topic:s.sent[0].topic,event:'broadcast',payload:{event:kind,payload:{project_id,revision}}});
notify(first,b,3);assert.equal(changes.length,1);notify(first,'invalid',4);notify(first,b,-1);assert.equal(changes.length,1);
account={...account,access_token:'refreshed'};channel.wake();assert.equal(sockets.length,1);assert.equal(first.sent.at(-1).event,'access_token');
const stale=first.onmessage;account={user:{id:b},access_token:'test-token-b'};channel.wake();assert.equal(first.readyState,3);assert.equal(sockets.length,2);
stale({data:JSON.stringify({topic:join.topic,event:'broadcast',payload:{event:'records',payload:{project_id:b,revision:5}}})});assert.equal(changes.length,1);
let second=sockets[1];second.open();ack(second);notify(second,a,0,'asset');assert.equal(changes.length,2);
const heartbeat=[...timers].find(([,x])=>x.ms===20000);timers.delete(heartbeat[0]);heartbeat[1].f();assert.equal(second.sent.at(-1).event,'heartbeat');
const missed=[...timers].find(([,x])=>x.ms===20000);timers.delete(missed[0]);missed[1].f();assert.equal(second.readyState,3);assert.equal(channel.connected,false);
online=false;channel.wake();assert.equal(timers.size,0);
online=true;channel.wake();assert.equal(sockets.length,3);channel.stop();assert.equal(timers.size,0);channel.wake();assert.equal(sockets.length,3);
console.log('private collaboration notifications: account isolation, token refresh, replay wake, heartbeat and offline lifecycle passed');

'use strict';
const assert=require('node:assert/strict'),vm=require('node:vm'),fs=require('node:fs');
const source=fs.readFileSync('sentlog/recovery-throttle.js','utf8');
const create=vm.runInNewContext(source+'\ncreateSentlogDeliveryGuard');
let time=100000;
const guard=create({now:()=>time});
const asset=(i,sha='a')=>({id:String(i).padStart(3,'0'),sha256:sha,byte_size:10,status:'storage_deleted',storage_path:'p'});
const assets=Array.from({length:40},(_,i)=>asset(i));
let visited=[];
for(let cycle=0;cycle<5;cycle++){
 assert(guard.begin('owner:device'));
 for(const a of guard.order(assets))if(guard.take(a))visited.push(a.id);
 assert(guard.full());guard.complete();time+=30000;
}
assert.equal(visited.length,40);assert.equal(new Set(visited).size,40,'round-robin prevents starvation');
const g=create({now:()=>time});
assert(g.begin('owner:device'));assert(g.take(asset(0)));assert(!g.take(asset(0)));
assert(g.take(asset(0,'b')),'changed hash has independent identity');
assert(g.take({...asset(0),storage_path:'new-path'}),'redelivery path has independent identity');
assert(g.take({...asset(0),status:'uploaded'}),'changed state has independent identity');
time+=59999;assert(g.begin('owner:device'));assert(!g.take(asset(0)));
time++;assert(g.begin('owner:device'));assert(g.take(asset(0)),'pending work becomes eligible again');
assert(g.fail({message:'canceling statement due to statement timeout'}));
assert(!g.begin('owner:device'));time+=29999;assert(!g.begin('owner:device'));
time++;assert(g.begin('owner:device'));assert(g.fail({status:503}));time+=30000;
assert(!g.begin('owner:device'));time+=30000;assert(g.begin('owner:device'));
assert(g.fail({name:'AbortError'}));time+=119999;assert(!g.begin('owner:device'));
time++;assert(g.begin('owner:device'));g.complete();assert(g.fail({status:429}));
time+=30000;assert(g.begin('owner:device'),'successful cycle resets backoff');
assert(!g.fail({message:'hash mismatch'}),'content mismatch is not treated as transient network failure');
g.fail({status:500});assert(g.begin('another-owner:device'),'identity change does not inherit unrelated cooldown');
assert(g.take(asset(0)));
for(const path of ['sentlog/pdf-recovery.js','sentlog/peer-photo-recovery.js']){
 const built=fs.readFileSync(path,'utf8');
 assert(built.includes(source.trim()),'built code embeds the exact tested helper');
 assert.match(built,/deliveryGuard\.begin/);assert.match(built,/deliveryGuard\.take/);
 assert.match(built,/deliveryGuard\.full/);assert.match(built,/deliveryGuard\.isTransient/);
 assert.match(built,/deliveryGuard\.fail/);assert.match(built,/deliveryGuard\.complete/);
}
console.log('PASS recovery guard: bounded attempts, 40 assets without starvation, per-file identity, expiry, 30/60/120s transient backoff and scope isolation');

'use strict';
// v1.40 regression: upgrade gates, fresh-device actions, history and transfer safety.
const fs=require('node:fs'),vm=require('node:vm'),assert=require('node:assert/strict');
const client=fs.readFileSync('sentlog/archive-capacity.js','utf8');
const details=fs.readFileSync('sentlog/capacity-details.js','utf8');
const pc=fs.readFileSync('sentlog/archive-restore-pc.js','utf8');
const loader=fs.readFileSync('sentlog/index.html','utf8');
const pcpage=fs.readFileSync('sentlog-pc/index.html','utf8');
const sql=fs.readFileSync('db/resilience_v2.sql','utf8');
for(const [name,code] of [['client',client],['details',details],['PC',pc]]){
 assert.doesNotThrow(()=>new vm.Script(code),name+' syntax');
}
assert(loader.includes("archive-capacity.js?v=140"));
assert(loader.includes("capacity-details.js?v=140"));
assert(loader.includes("'v1.40'"));
assert(pcpage.includes('archive-restore-pc.js?v=140'));
assert(client.includes('const fresh=!mark?.mode&&!localProject'));
assert(client.includes("const restoreMode=mark?.mode||'project'"));
assert(client.includes("if(mark){const nextMark=state();delete nextMark[cp.id]"));
assert(client.includes("await S.archiveAtomic({writes,deleteFiles:"));
assert(client.includes('const partCount=multipart?Math.ceil'));
assert(client.includes('if(!await C.matches(blob,f))'));
assert(client.includes('removed_bytes:counter2.bytes'));
assert(pc.includes('uploadChunk(partName(target,i)'));
assert(pc.includes("'Content-Type':mime"));
assert(pc.includes('archiveMime(f)'));
assert(!pc.includes("'Content-Type':part.type||'application/octet-stream'"));
assert(pc.includes('const prefixes=(entry.manifest||[]).flatMap'));
assert(pc.includes('C.validatePack(pack,job)'));
assert(details.includes('sentlog_backup_status_v2'));
assert(sql.includes('CREATE TRIGGER sentlog_audit_project_v2'));
assert(sql.includes('CREATE TRIGGER sentlog_audit_capacity_v2'));
assert(sql.includes('CREATE TRIGGER sentlog_audit_job_v2'));
assert(sql.includes('WHERE id=p_project_id AND owner_id=uid'));
assert(sql.includes('sentlog_reopen_v2'));

const records=new Map();
records.set('surveyFieldNoteWorkspaceV1',JSON.stringify({projects:[]}));
const host=()=>({nodes:[],append(n){this.nodes.push(n);}});
const makeNode=(tag)=>({tag,style:{},textContent:'',className:'',disabled:false,append(){},setAttribute(){},onclick:null});
const ctx=vm.createContext({
 console,Blob,Promise,navigator:{onLine:true},document:{createElement:makeNode,head:{append(){}}},
 localStorage:{getItem:()=>null},window:null,renderProjects:()=>{},
 SentlogArchiveCore:{},SentlogRecords:{getItem:k=>records.get(k)||null},
 sentlogAppReady:new Promise(()=>{}),
});
ctx.window=ctx;
vm.runInContext(client,ctx);
const cp={id:'cloud-case',client_key:'local-case',status:'archived',retired:false,checking:false};
let container=host();
ctx.SentlogCapacity.renderActions(container,cp,{});
let buttons=container.nodes.filter(n=>n.tag==='button');
assert.equal(buttons.length,3);
assert.equal(buttons[0].disabled,true,'new device cannot release absent files');
assert.equal(buttons[1].disabled,true);
assert.equal(buttons[2].disabled,false,'new device can request verified PC restore');
records.set('surveyFieldNoteWorkspaceV1',JSON.stringify({projects:[{id:'local-case',drawings:[]}]}));
container=host();ctx.SentlogCapacity.renderActions(container,cp,{});
buttons=container.nodes.filter(n=>n.tag==='button');
assert.equal(buttons[0].disabled,false,'local copy can be released after PC recheck');
assert.equal(buttons[2].disabled,true,'no overwrite on already-present local project');
records.set('sentlogArchiveLocalV1',JSON.stringify({'cloud-case':{mode:'project',job_id:'job-x',revision:1}}));
records.set('surveyFieldNoteWorkspaceV1',JSON.stringify({projects:[]}));
container=host();ctx.SentlogCapacity.renderActions(container,cp,{});
buttons=container.nodes.filter(n=>n.tag==='button');
assert.equal(buttons[0].disabled,true);
assert.equal(buttons[2].disabled,false,'cleared device can restore');
container=host();ctx.SentlogCapacity.renderActions(container,{...cp,retired:true},{});
assert(container.nodes.filter(n=>n.tag==='button').every(n=>n.disabled));
console.log('PASS v1.40: valid JS, versioned loaders, backup audit, new-device / local / retired gates, chunking and savings');

'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const root=path.resolve(process.argv[2]||path.join(__dirname,'..'));
const source=fs.readFileSync(path.join(root,'sentlog/project-sync-controls.txt'),'utf8');
function fixture(){
  class Element{
    constructor(){this.children=[];this.value='';this.textContent='';this.disabled=false;}
    appendChild(child){this.children.push(child);return child;}
    replaceChildren(){this.children=[];this.value='';}
  }
  const select=new Element(),button=new Element(),calls=[],messages=[];
  const projects=[{id:'old',name:'使用中の案件',updatedAt:1},{id:'new-local',name:'新しい案件 <&>',updatedAt:3},{id:'archived',name:'保管中',updatedAt:2}];
  const timers=new Map();let nextTimer=0;
  const h={projects,calls,messages,select,button,timers,refreshes:0,reply:async()=>({started:true}),
    expire(){for(const [id,entry] of [...timers]){timers.delete(id);entry.fn();}}};
  const context={Map,String,Number,session:{user:{id:'owner'}},navigator:{onLine:true},
    setTimeout:(fn,ms)=>{const id=++nextTimer;timers.set(id,{fn,ms});return id;},clearTimeout:id=>timers.delete(id),
    document:{getElementById:id=>id==='sentlogSyncProjectSelect'?select:id==='sentlogSyncProjectNow'?button:null,createElement:()=>new Element()},
    workspace:()=>({projects}),knownCloudProjects:new Map([['cloud-old',{id:'cloud-old',client_key:'old',status:'active'}],['cloud-archived',{id:'cloud-archived',client_key:'archived',status:'archived'}]]),
    archive:{ready:true,includeLocal:id=>id!=='archived'},msg:(message,ok)=>messages.push({message,ok}),
    syncStatus:{refresh:()=>h.refreshes++},syncNow:async options=>{calls.push(JSON.parse(JSON.stringify(options)));return h.reply();}};
  vm.createContext(context);h.context=context;h.api=vm.runInContext(source+'\n;({render:renderProjectSyncControls,run:syncSelectedProject,request:requestProjectSync,requests:projectSyncRequests});',context);return h;
}
(async()=>{
  let h=fixture();h.api.render();
  assert.deepEqual(h.select.children.map(o=>o.value),['new-local','old']);assert.equal(h.select.value,'new-local');
  assert.equal(h.select.children[0].textContent,'新しい案件 <&>');assert.equal(h.button.disabled,false);
  h.select.value='old';h.api.render();assert.equal(h.select.value,'old','refresh preserves the selected local ID');
  console.log('PASS unsent local projects are selectable and archived projects stay excluded');
  h=fixture();h.api.render();await h.api.run();
  assert.deepEqual(h.calls,[{force:true,projectIds:['new-local']}]);assert.equal(h.refreshes,1);
  assert(!h.messages.some(m=>/完了|成功/.test(m.message)),'starting a request is not a completion receipt');
  assert.equal(h.button.disabled,false);console.log('PASS selected local project alone is forced without reporting false completion');
  h=fixture();h.api.render();h.context.navigator.onLine=false;await h.api.run();assert.equal(h.calls.length,0);assert.match(h.messages.at(-1).message,/オンライン/);
  h.context.navigator.onLine=true;h.context.session=null;await h.api.run();assert.equal(h.calls.length,0);assert.match(h.messages.at(-1).message,/ログイン/);
  console.log('PASS offline and signed-out requests do not start');
  h=fixture();h.api.render();h.reply=async()=>({started:false});await h.api.run();assert.match(h.messages.at(-1).message,/開始できません/);
  h.reply=async()=>{throw Error('保存状態を確認できません');};await h.api.run();assert.equal(h.messages.at(-1).message,'保存状態を確認できません');
  console.log('PASS paused or failed requests retain an actionable message');
  h=fixture();h.api.render();let release;h.reply=()=>new Promise(resolve=>release=resolve);
  const first=h.api.run();await h.api.run();assert.equal(h.calls.length,1);assert.equal(h.button.disabled,true);
  h.context.session={user:{id:'other-owner'}};const count=h.messages.length;release({started:true});await first;
  assert.equal(h.messages.length,count,'old account results do not rewrite the new account message');assert.equal(h.refreshes,0);
  console.log('PASS duplicate clicks are serialized and account changes discard old UI results');
  h=fixture();h.api.render();let finishSlow;h.reply=()=>new Promise(resolve=>finishSlow=resolve);
  const slow=h.api.run();await Promise.resolve();assert.equal(h.calls.length,1);
  assert.equal([...h.timers.values()][0].ms,30000);h.expire();await slow;
  assert.equal(h.button.disabled,false);assert.equal(h.select.disabled,false);assert.equal(h.api.requests.size,1);
  assert.match(h.messages.at(-1).message,/完了はまだ確認できていません/);
  const resumed=h.api.run();await Promise.resolve();assert.equal(h.calls.length,1,'rechecking observes the same live job');
  finishSlow({started:true});await resumed;assert.equal(h.api.requests.size,0);assert.equal(h.button.disabled,false);
  assert.equal(h.messages.at(-1).message,'');assert.equal(h.timers.size,0);
  console.log('PASS a 30-second UI wait releases controls without cancelling or duplicating the save');
  h=fixture();h.api.render();let finishOther;h.reply=()=>new Promise(resolve=>finishOther=resolve);
  const oldSelection=h.api.run();await Promise.resolve();h.expire();await oldSelection;
  h.select.value='old';const countBefore=h.messages.length;finishOther({started:true});await Promise.resolve();await Promise.resolve();
  assert.equal(h.messages.length,countBefore,'a late result cannot erase another selected project message');
  console.log('PASS late results stay bound to the selected project');
  h=fixture();h.api.render();let finishOldAccount;h.reply=()=>new Promise(resolve=>finishOldAccount=resolve);
  const oldAccount=h.api.run();await Promise.resolve();h.expire();await oldAccount;
  h.context.session={user:{id:'second'}};h.api.render();h.context.session={user:{id:'owner'}};h.api.render();
  const oldMessageCount=h.messages.length;assert.equal(h.api.requests.size,0,'account changes retire only the old UI observation');
  finishOldAccount({started:false});await Promise.resolve();await Promise.resolve();
  assert.equal(h.messages.length,oldMessageCount,'returning to the same account cannot revive an earlier result');
  console.log('PASS leaving and returning to an account invalidates its earlier UI observation');
  h=fixture();h.api.render();const fresh=h.api.request('new-local');h.context.session={user:{id:'changed'}};
  await assert.rejects(fresh,/ログインが変更/);assert.equal(h.calls.length,0);assert.equal(h.api.requests.size,0);
  console.log('PASS an account switch before dispatch cannot start work for the new account');
  const cloud=fs.readFileSync(path.join(root,'sentlog/cloud-sync.js'),'utf8');
  if(cloud.includes('project-sync-controls-v1')){
    const index=fs.readFileSync(path.join(root,'sentlog/index.html'),'utf8');
    assert(cloud.includes("document.getElementById('sentlogSyncProjectNow').onclick=syncSelectedProject"));
    assert(cloud.includes('id="sentlogSyncProjectSelect"'));assert(cloud.includes('function updateCloudUI(){\n  renderProjectSyncControls();'));
    assert.equal((index.match(/cloud-sync\.js\?v=20261119-project-sync-1/g)||[]).length,2);
    const dependencyMarker=cloud.includes('sentlog-camera-order-return-v1')?'sentlog-camera-order-return-v1':
      cloud.includes('sentlog-delta-app-v1')?'sentlog-delta-app-v1':'project-sync-controls-v1';
    assert(index.includes("'"+dependencyMarker+"'"));console.log('PASS production modal and both bootstrap references use the new controls');
  }
})().catch(error=>{console.error(error);process.exitCode=1;});

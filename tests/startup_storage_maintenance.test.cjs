'use strict';
// Actual entry/UI modules, with a small DOM and controlled writer boundary.
// Native IndexedDB and the maintenance writer are exercised by their own
// suites; these tests prove that this route never boots the normal editor.
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const read=name=>fs.readFileSync(path.join(__dirname,'../sentlog',name),'utf8');
const METHODS=['compactRedundantRecords','compactRedundantFiles','compactRedundantPageBackups'];
const IDS={prepare:'startupMaintenancePrepare',host:'startupMaintenanceHost',status:'startupMaintenanceStatus',
  open:'startupMaintenanceOpenApp',diagnostics:'startupMaintenanceDiagnostics',rescue:'startupMaintenanceRescue',
  review:'sentlogStorageMaintenanceReview',run:'sentlogStorageMaintenanceRun',stop:'sentlogStorageMaintenanceStop',
  workStatus:'sentlogStorageMaintenanceStatus',section:'sentlogStorageMaintenanceSection',route:'sentlogStandaloneMaintenanceLink'};
function deferred(){let resolve,reject;const promise=new Promise((yes,no)=>{resolve=yes;reject=no;});return {promise,resolve,reject};}
const pause=()=>new Promise(resolve=>setTimeout(resolve,0));
async function until(check){const deadline=Date.now()+3000;while(!check()){if(Date.now()>deadline)throw Error('Standalone UI did not settle');await pause();}}
function fixture({standalone=true,initialize,pass}={}){
  const elements=new Map(),observers=[],calls=[];let inits=0,normalInits=0,network=0,estimates=0,flushes=0;
  function signal(target,key){queueMicrotask(()=>{for(const observer of observers){let parent=target,contains=parent===observer.target;
    if(observer.options.subtree)while(!contains&&parent?.parentNode){parent=parent.parentNode;contains=parent===observer.target;}
    if(contains&&observer.options.attributes&&(!observer.options.attributeFilter||observer.options.attributeFilter.includes(key)))observer.fn();}});}
  class Element{
    constructor(tag){this.tag=tag;this.children=[];this.attributes=new Map();this.handlers=new Map();this.hidden=false;this.disabled=false;this.textContent='';}
    set id(value){this._id=value;elements.set(value,this);}get id(){return this._id;}
    append(...nodes){for(const item of nodes){this.children.push(item);item.parentNode=this;}}
    replaceChildren(...nodes){this.children=[];this.append(...nodes);}
    setAttribute(key,value){this.attributes.set(key,String(value));signal(this,key);}
    removeAttribute(key){this.attributes.delete(key);signal(this,key);}
    getAttribute(key){return this.attributes.get(key)??null;}
    addEventListener(name,fn){if(!this.handlers.has(name))this.handlers.set(name,[]);this.handlers.get(name).push(fn);}
    before(){}
    click(){let prevented=false,stopped=false;const event={preventDefault(){prevented=true;},stopPropagation(){stopped=true;}};
      if(this.disabled)return {prevented,stopped};const returned=this.onclick?.(event);for(const fn of this.handlers.get('click')||[])fn(event);return {prevented,stopped,returned};}
  }
  class Observer{constructor(fn){this.fn=fn;}observe(target,options){this.target=target;this.options=options;observers.push(this);}disconnect(){const i=observers.indexOf(this);if(i>=0)observers.splice(i,1);}}
  const head=new Element('head'),normalHost=new Element('host'),body=new Element('body');
  const add=(key,tag)=>{const el=new Element(tag);el.id=IDS[key];body.append(el);return el;};
  if(standalone){add('prepare','button').disabled=true;const host=add('host','section');host.hidden=true;host.inert=true;
    add('status','p').textContent='まだ保存領域を開いていません。';
    for(const [key,href]of [['open','./'],['diagnostics','./storage-check.html'],['rescue','./rescue.html']])add(key,'a').href=href;
  }else{const modal=new Element('modal');modal.id='sentlogSettingsModal';modal.setAttribute('aria-hidden','false');modal.append(normalHost);body.append(modal);}
  const records={maintenanceInitVersion:1,journalReadBudgetVersion:1,storageMaintenanceVersion:1,ready:!standalone,pending:false,failed:false,
    assertSafe(){if(this.failed)throw Error('synthetic storage failure');},
    init(){normalInits++;throw Error('Normal editor initialization is forbidden');},
    flush(){flushes++;throw Error('Navigation must not flush');},
    async initForMaintenance(){inits++;if(initialize)await initialize(inits);this.ready=true;},deltaJournal:{}};
  for(const method of METHODS)records.deltaJournal[method]=async options=>{
    assert.equal(records.ready,true);assert.equal(options.scanLimit,standalone?32:128);assert.equal(options.limit,standalone?8:32);
    calls.push({method,...options});
    if(pass)return pass(method,options,calls);
    return {scanned:1,eligible:1,updated:options.dryRun?0:1,logicalBytesEligible:1024,logicalBytesRemoved:options.dryRun?0:1024,done:true,nextCursor:options.cursor};
  };
  const context={document:{createElement:tag=>new Element(tag),getElementById:id=>elements.get(id)||null,
    querySelector:selector=>selector==='#sentlogSettingsModal .modal-card'&&!standalone?normalHost:null,head,body},
    SentlogRecords:records,MutationObserver:Observer,AbortController,setTimeout,clearTimeout,queueMicrotask,console,
    navigator:{storage:{estimate:async()=>{estimates++;return {usage:10000};}}},
    fetch(){network++;throw Error('Network is forbidden');},addEventListener(){}};
  vm.createContext(context);vm.runInContext(read('storage-maintenance-ui.js'),context);vm.runInContext(read('startup-storage-maintenance.js'),context);
  const element=key=>elements.get(IDS[key]||key);
  return {context,records,calls,element,get inits(){return inits;},get normalInits(){return normalInits;},get network(){return network;},
    get estimates(){return estimates;},get flushes(){return flushes;},
    async prepare(){await element('prepare').click().returned;await pause();},
    async action(key){element(key).click();await until(()=>!context.SentlogStorageMaintenanceUI.busy);await pause();}};
}
const tests=[],test=(name,run)=>tests.push([name,run]);
test('the independent page loads only three pinned modules and forbids network, workers and media',()=>{
  const html=read('storage-maintenance.html'),sources=[...html.matchAll(/<script\s+src="([^"]+)"\s+defer><\/script>/g)].map(match=>match[1]);
  assert.deepEqual(sources,['record-store','storage-maintenance-ui','startup-storage-maintenance'].map(name=>'./'+name+'.js?v=20261128-operation-memory-216'));
  assert.equal((html.match(/<script\b/g)||[]).length,3);assert.match(html,/connect-src 'none'/);assert.match(html,/worker-src 'none'/);assert.match(html,/img-src 'none'/);
  assert.doesNotMatch(html,/<iframe|<img|<canvas|<video|cloud-sync\.js|part0[1-9]\.txt|pdf-quality\.js/i);
  assert.doesNotMatch(read('startup-storage-maintenance.js'),/location\.(?:reload|href)|serviceWorker|\.init\(/);
  assert.match(html,/id="startupMaintenanceHost"[^>]*hidden inert/);assert.match(html,/未保存の記録/);
});
test('opening the page only wires the UI and leaves the writer, passes and estimate untouched',async()=>{
  const f=fixture();await pause();assert.equal(f.inits,0);assert.equal(f.normalInits,0);assert.equal(f.calls.length,0);assert.equal(f.estimates,0);assert.equal(f.network,0);
  assert(f.element('host').hidden);assert(f.element('host').inert);assert(!f.element('prepare').disabled);assert(!f.element('open').getAttribute('aria-disabled'));
});
test('explicit preparation is read-only initialization only; repeated clicks cannot start it twice',async()=>{
  const gate=deferred(),f=fixture({initialize:()=>gate.promise});
  const first=f.element('prepare').click().returned;assert.equal(f.inits,1);f.element('prepare').click();assert.equal(f.inits,1);
  assert.equal(f.element('open').getAttribute('aria-disabled'),'true');assert.equal(f.element('open').click().prevented,true);assert(f.element('host').hidden);
  gate.resolve();await first;await pause();assert.equal(f.calls.length,0);assert.equal(f.normalInits,0);assert.equal(f.network,0);
  assert(!f.element('host').hidden);assert(!f.element('host').inert);assert(f.element('prepare').hidden);assert.equal(f.element('open').getAttribute('aria-disabled'),null);
  assert.match(f.element('status').textContent,/まだ整理は実行していません/);assert.equal(f.context.SentlogStartupStorageMaintenance.ready,true);
});
test('a missing maintenance capability stops before initialization and exposes no cleanup controls',async()=>{
  const f=fixture();f.records.maintenanceInitVersion=0;await f.prepare();assert.equal(f.inits,0);assert(f.element('host').hidden);assert(!f.element('prepare').disabled);
  assert.match(f.element('status').textContent,/最新版/);assert.equal(f.element('open').getAttribute('aria-disabled'),null);
});
test('a blocked or missing existing database can be retried without calling normal init',async()=>{
  const f=fixture({initialize:async number=>{if(number===1)throw Error('existing database unavailable');}});
  await f.prepare();assert.match(f.element('status').textContent,/existing database unavailable/);assert(f.element('host').hidden);assert(!f.element('prepare').disabled);
  await f.prepare();assert.equal(f.inits,2);assert.equal(f.normalInits,0);assert(!f.element('host').hidden);assert.equal(f.calls.length,0);
});
test('standalone preview and fresh cleanup reuse all three bounded safety APIs',async()=>{
  const f=fixture();await f.prepare();await f.action('review');assert.equal(f.calls.length,3);assert(f.calls.every(call=>call.dryRun));assert(!f.element('run').hidden);
  await f.action('run');assert.equal(f.calls.length,6);assert(f.calls.slice(3).every(call=>!call.dryRun));
  assert.deepEqual(f.calls.slice(3).map(call=>call.cursor),[0,0,'']);assert.match(f.element('workStatus').textContent,/整理が完了しました/);
  assert.equal(f.element('open').href,'./');assert.equal(f.element('open').getAttribute('aria-disabled'),null);assert.equal(f.network,0);
});
test('all exit links are blocked throughout an in-flight pass and restored after cancellation',async()=>{
  const entered=deferred();let waiting=true;
  const f=fixture({pass:async(method,options)=>{
    if(waiting){entered.resolve(options);await new Promise((resolve,reject)=>options.signal.addEventListener('abort',()=>{waiting=false;reject(Object.assign(Error('cancelled'),{name:'AbortError'}));},{once:true}));}
    return {scanned:1,eligible:0,updated:0,logicalBytesEligible:0,logicalBytesRemoved:0,done:true,nextCursor:options.cursor};
  }});
  await f.prepare();f.element('review').click();await entered.promise;await pause();
  for(const key of ['open','diagnostics','rescue']){assert.equal(f.element(key).getAttribute('aria-disabled'),'true');assert.equal(f.element(key).click().prevented,true);}
  f.element('stop').click();await until(()=>!f.context.SentlogStorageMaintenanceUI.busy);await pause();
  for(const key of ['open','diagnostics','rescue']){assert.equal(f.element(key).getAttribute('aria-disabled'),null);assert.equal(f.element(key).click().prevented,false);}
  assert.match(f.element('workStatus').textContent,/処理を中止しました/);assert.equal(f.element('review').textContent,'続きの重複を確認');
});
test('normal settings expose the direct route but protect pending or failed saves without flushing',()=>{
  const f=fixture({standalone:false}),link=f.element('route');assert(link);assert.equal(link.href,'./storage-maintenance.html?v=20261128-operation-memory-216');
  assert.equal(link.click().prevented,false);f.records.pending=true;assert.equal(link.click().prevented,true);assert.match(f.element('workStatus').textContent,/画面は開いたまま/);
  f.records.pending=false;f.records.failed=true;assert.equal(link.click().prevented,true);assert.match(f.element('workStatus').textContent,/控え/);assert.equal(f.flushes,0);
  f.records.failed=false;assert.equal(link.click().prevented,false);assert.equal(f.inits,0);assert.equal(f.context.SentlogStartupStorageMaintenance,undefined);
});
test('normal modal navigation is also blocked during review and standalone never adds a self-link',async()=>{
  const gate=deferred();const f=fixture({standalone:false,pass:async(method,options)=>{await gate.promise;return {scanned:0,eligible:0,updated:0,logicalBytesEligible:0,logicalBytesRemoved:0,done:true,nextCursor:options.cursor};}});
  f.element('review').click();assert.equal(f.element('route').click().prevented,true);gate.resolve();await until(()=>!f.context.SentlogStorageMaintenanceUI.busy);
  assert.equal(f.element('route').click().prevented,false);assert.equal(fixture().element('route'),undefined);
});
(async()=>{let passed=0;for(const [name,run]of tests){await run();passed++;console.log('PASS',name);}
  console.log(JSON.stringify({passed,total:tests.length,actualEntryAndUI:true,normalBoots:0,nativeBrowserExecuted:false}));
})().catch(error=>{console.error(error);process.exitCode=1;});

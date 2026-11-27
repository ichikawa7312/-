'use strict';
// Execute the actual maintenance UI with a small DOM and a virtual clock.
// Storage API transactions/byte proofs are covered by the writer suites;
// these checks cover UI continuation, fresh execution and cancellation wiring.
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const source=fs.readFileSync(path.join(__dirname,'../sentlog/storage-maintenance-ui.js'),'utf8');
const METHODS=['compactRedundantRecords','compactRedundantFiles','compactRedundantPageBackups'];
const IDS={review:'sentlogStorageMaintenanceReview',run:'sentlogStorageMaintenanceRun',stop:'sentlogStorageMaintenanceStop',
  status:'sentlogStorageMaintenanceStatus',result:'sentlogStorageMaintenanceResult',section:'sentlogStorageMaintenanceSection'};
const pause=()=>new Promise(resolve=>setTimeout(resolve,0));
async function until(check){const deadline=Date.now()+3000;while(!check()){if(Date.now()>deadline)throw Error('UI did not settle');await pause();}}
function deferred(){let resolve,reject;const promise=new Promise((yes,no)=>{resolve=yes;reject=no;});return {promise,resolve,reject};}
function report(options,{eligible=1,done=true,nextCursor=options.cursor,bytes=1024}={}){
  return {scanned:1,eligible,updated:options.dryRun?0:eligible,logicalBytesEligible:eligible*bytes,
    logicalBytesRemoved:options.dryRun?0:eligible*bytes,done,nextCursor};
}
function fixture(handler,{capability=1,pending=false,estimates=[]}={}){
  const elements=new Map(),observers=[],events=new Map();let now=0,estimateCalls=0;
  class Element{
    constructor(tag){this.tag=tag;this.children=[];this.attributes=new Map();this.hidden=false;this.disabled=false;this.textContent='';}
    set id(value){this._id=value;elements.set(value,this);}get id(){return this._id;}
    append(...nodes){this.children.push(...nodes);for(const child of nodes)child.parentNode=this;}
    replaceChildren(...nodes){this.children=[];this.append(...nodes);}
    setAttribute(key,value){this.attributes.set(key,value);}removeAttribute(key){this.attributes.delete(key);}
    getAttribute(key){return this.attributes.get(key)??null;}before(){}
  }
  class Observer{
    constructor(callback){this.callback=callback;}observe(target,options){this.target=target;this.options=options;observers.push(this);}
    disconnect(){const index=observers.indexOf(this);if(index>=0)observers.splice(index,1);}
  }
  const host=new Element('host'),head=new Element('head'),modal=new Element('modal');modal.id='sentlogSettingsModal';modal.setAttribute('aria-hidden','false');
  const calls=[],records={storageMaintenanceVersion:capability,pending,assertSafe(){},deltaJournal:{}};
  const f={calls,records,advance(ms){now+=ms;},element:key=>elements.get(IDS[key]||key),get estimateCalls(){return estimateCalls;}};
  for(const method of METHODS)records.deltaJournal[method]=async options=>{
    assert.equal(typeof options.dryRun,'boolean');assert.equal(options.scanLimit,128);assert.equal(options.limit,32);
    assert(options.signal instanceof AbortSignal,'Every pass must receive the UI cancellation signal');
    const call={method,...options};calls.push(call);return handler(call,f);
  };
  const context={document:{createElement:tag=>new Element(tag),querySelector:()=>host,getElementById:id=>elements.get(id),head},
    SentlogRecords:records,Date:{now:()=>now},AbortController,MutationObserver:Observer,setTimeout,clearTimeout,console,
    navigator:{storage:{estimate:async()=>({usage:estimates[estimateCalls++]??10000})}},
    addEventListener(name,callback){events.set(name,callback);}};
  vm.createContext(context);vm.runInContext(source,context);
  function text(node){return [node.textContent,...node.children.map(text)].filter(Boolean).join('\n');}
  f.result=()=>text(f.element('result'));f.status=()=>f.element('status').textContent;
  f.start=key=>{
    const button=f.element(key);assert(!button.hidden&&!button.disabled,key+' must be available');
    let failure=null;const value=button.onclick();if(value?.then)value.catch(error=>{failure=error;});
    return until(()=>!f.element('section').attributes.has('aria-busy')).then(()=>{if(failure)throw failure;});
  };
  f.stop=()=>{assert(!f.element('stop').hidden);f.element('stop').onclick();};
  f.modalHidden=value=>{modal.setAttribute('aria-hidden',String(value));for(const observer of observers)if(observer.target===modal)observer.callback();};
  f.pagehide=()=>events.get('pagehide')?.();
  return f;
}
const tests=[],test=(name,run)=>tests.push([name,run]);
test('a review longer than three minutes resumes its cursor, later phases and cumulative total',async()=>{
  const f=fixture((options,f)=>{
    assert.equal(options.dryRun,true);f.advance(70000);
    const index=options.method===METHODS[2]?(options.cursor===''?0:1):options.cursor;
    const length=options.method===METHODS[0]?4:2,done=index===length-1;
    return report(options,{done,nextCursor:options.method===METHODS[2]?'page-replace-backup:drawing-1':index+1});
  });
  await f.start('review');assert.deepEqual(f.calls.map(c=>[c.method,c.cursor]),[[METHODS[0],0],[METHODS[0],1],[METHODS[0],2]]);
  assert.equal(f.element('review').textContent,'続きの重複を確認');assert.equal(f.element('run').hidden,false);
  assert.match(f.result(),/3\.0 KiB \/ 3項目/);assert.match(f.status(),/続きの位置から再開/);
  await f.start('review');assert.deepEqual(f.calls.slice(3).map(c=>[c.method,c.cursor]),[[METHODS[0],3],[METHODS[1],0],[METHODS[1],1]]);
  assert.match(f.result(),/6\.0 KiB \/ 6項目/);
  await f.start('review');assert.deepEqual(f.calls.slice(6).map(c=>[c.method,c.cursor]),[[METHODS[2],''],[METHODS[2],'page-replace-backup:drawing-1']]);
  assert.match(f.result(),/8\.0 KiB \/ 8項目/);assert.match(f.status(),/確認が終わりました/);
  assert.equal(f.element('review').textContent,'整理できる重複を確認');assert.equal(f.element('run').hidden,false);
});
test('a partial review can start fresh cleanup, and paused cleanup resumes without repeating committed rows',async()=>{
  const f=fixture((options,f)=>{
    if(options.dryRun){f.advance(190000);return report(options,{done:false,nextCursor:5});}
    if(options.method===METHODS[0]&&options.cursor===0){f.advance(190000);return report(options,{eligible:2,done:false,nextCursor:7});}
    return report(options);
  },{estimates:[10000,8000,6000]});
  await f.start('review');assert.equal(f.element('run').hidden,false);assert.match(f.result(),/1\.0 KiB \/ 1項目/);
  await f.start('run');const firstWrite=f.calls.find(c=>!c.dryRun);
  assert.equal(firstWrite.method,METHODS[0]);assert.equal(firstWrite.cursor,0,'Execution must re-prove from zero, not trust review cursor 5');
  assert.equal(f.element('run').textContent,'整理を続ける');assert.match(f.result(),/2\.0 KiB \/ 2項目/);
  await f.start('run');assert.deepEqual(f.calls.filter(c=>!c.dryRun).map(c=>[c.method,c.cursor]),
    [[METHODS[0],0],[METHODS[0],7],[METHODS[1],0],[METHODS[2],'']]);
  assert.match(f.result(),/5\.0 KiB \/ 5項目/);assert.match(f.status(),/整理が完了しました/);
  assert.equal(f.element('run').hidden,true);assert.equal(f.estimateCalls,3,'Keep the initial usage measurement across cleanup continuations');
  assert.match(f.result(),/9\.8 KiB → 5\.9 KiB/);
});
test('stop aborts an in-flight Blob review and resumes the uncompleted pass without recounting earlier results',async()=>{
  const entered=deferred();let interrupted=false;
  const f=fixture(options=>{
    if(options.method===METHODS[1]&&!interrupted){interrupted=true;entered.resolve(options.signal);return new Promise((resolve,reject)=>{
      options.signal.addEventListener('abort',()=>reject(Object.assign(Error('synthetic read cancelled'),{name:'AbortError'})),{once:true});
    });}
    return report(options);
  });
  const action=f.start('review'),signal=await entered.promise;assert.equal(signal.aborted,false);f.stop();await action;
  assert.equal(signal.aborted,true);assert.match(f.status(),/処理を中止しました/);assert.doesNotMatch(f.status(),/完了できません/);
  assert.match(f.result(),/1\.0 KiB \/ 1項目/);assert.equal(f.element('run').hidden,false);
  await f.start('review');assert.deepEqual(f.calls.map(c=>[c.method,c.cursor]),[[METHODS[0],0],[METHODS[1],0],[METHODS[1],0],[METHODS[2],'']]);
  assert.equal(f.calls[2].signal.aborted,false);assert.notEqual(f.calls[2].signal,signal);
  assert.match(f.result(),/3\.0 KiB \/ 3項目/);assert.match(f.status(),/確認が終わりました/);
});
for(const exit of ['modal','pagehide'])test(exit+' cancels a pending cleanup pass and preserves the continuation and committed total',async()=>{
  const entered=deferred();let interrupted=false,committed=0;
  const f=fixture(options=>{
    if(!options.dryRun&&options.method===METHODS[1]&&!interrupted){interrupted=true;entered.resolve(options.signal);return new Promise((resolve,reject)=>{
      options.signal.addEventListener('abort',()=>reject(Object.assign(Error('synthetic write cancelled before commit'),{name:'AbortError'})),{once:true});
    });}
    if(!options.dryRun)committed++;return report(options);
  });
  await f.start('review');const action=f.start('run'),signal=await entered.promise;
  if(exit==='modal')f.modalHidden(true);else f.pagehide();await action;
  assert.equal(signal.aborted,true);assert.equal(committed,1);assert.match(f.result(),/1\.0 KiB \/ 1項目/);
  assert.equal(f.element('run').textContent,'整理を続ける');assert.equal(f.element('run').hidden,false);assert.match(f.status(),/処理を中止しました/);
  f.modalHidden(false);await f.start('run');assert.equal(committed,3);assert.match(f.result(),/3\.0 KiB \/ 3項目/);
  assert.deepEqual(f.calls.filter(c=>!c.dryRun).map(c=>[c.method,c.cursor]),[[METHODS[0],0],[METHODS[1],0],[METHODS[1],0],[METHODS[2],'']]);
  assert.equal(f.element('run').hidden,true);
});
test('a failed write pass is not reported as removed and is retried from its last confirmed cursor',async()=>{
  let failed=false;
  const f=fixture(options=>{
    if(!options.dryRun&&options.method===METHODS[1]&&!failed){failed=true;throw Object.assign(Error('synthetic concurrent file change'),{code:'JOURNAL_MAINTENANCE_CHANGED'});}
    return report(options);
  });
  await f.start('review');await f.start('run');assert.match(f.status(),/整理を完了できませんでした.*synthetic concurrent file change/);
  assert.match(f.result(),/1\.0 KiB \/ 1項目/);assert.equal(f.element('run').textContent,'整理を続ける');
  await f.start('run');assert.match(f.result(),/3\.0 KiB \/ 3項目/);assert.match(f.status(),/整理が完了しました/);
  assert.deepEqual(f.calls.filter(c=>!c.dryRun).map(c=>[c.method,c.cursor]),[[METHODS[0],0],[METHODS[1],0],[METHODS[1],0],[METHODS[2],'']]);
});
test('an old writer or pending save stops before any storage pass, and a later idle retry begins at zero',async()=>{
  const old=fixture(options=>report(options),{capability:0});await old.start('review');assert.equal(old.calls.length,0);
  assert.match(old.status(),/最新版/);assert.equal(old.element('run').hidden,true);
  const busy=fixture(options=>report(options),{pending:true});await busy.start('review');assert.equal(busy.calls.length,0);
  assert.match(busy.status(),/保存処理が進行中/);assert.equal(busy.element('run').hidden,true);
  busy.records.pending=false;await busy.start('review');assert.deepEqual(busy.calls.map(c=>[c.method,c.cursor]),[[METHODS[0],0],[METHODS[1],0],[METHODS[2],'']]);
  assert.match(busy.status(),/確認が終わりました/);assert.equal(busy.element('run').hidden,false);
});
(async()=>{let passed=0,failed=0;for(const [name,run]of tests)try{await run();passed++;console.log('PASS',name);}catch(error){failed++;console.error('FAIL',name,error.stack);}
  console.log(JSON.stringify({passed,failed,total:tests.length,virtualClock:true,actualUIModule:true,nativeBrowserExecuted:false}));if(failed)process.exitCode=1;
})().catch(error=>{console.error(error);process.exitCode=1;});

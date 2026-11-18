// Exercise the real editor and immutable model with a small event-driven DOM.
'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm'),path=require('node:path');
const C=require('../sentlog/record-collaboration.js');
const copy=x=>JSON.parse(JSON.stringify(x));
const modelCode=fs.readFileSync(path.join(__dirname,'../sentlog/record-collaboration.js'),'utf8');
const editorCode=fs.readFileSync(path.join(__dirname,'../sentlog/collaboration-editor.js'),'utf8');
const legacyPart=fs.readFileSync(path.join(__dirname,'../sentlog/part06.txt'),'utf8');
const legacyPhotoRemove=legacyPart.slice(legacyPart.indexOf('async function removeSelectedPhoto(photoId){'),legacyPart.indexOf('async function openPhotoViewer('));
const camel=s=>s.replace(/-([a-z])/g,(_,c)=>c.toUpperCase());
class Element{
  constructor(tag,document){this.tagName=tag.toUpperCase();this.ownerDocument=document;this.children=[];this.attributes={};this.dataset={};this.style={};this.listeners={};this.hidden=false;this.disabled=false;this.value='';this._text='';this.id='';this.className='';}
  setAttribute(k,v){this.attributes[k]=String(v);if(k==='id')this.id=String(v);if(k==='class')this.className=String(v);if(k.startsWith('data-'))this.dataset[camel(k.slice(5))]=String(v);}
  append(...children){for(const child of children){if(typeof child==='string'){this._text+=child;continue;}child.remove();child.parentElement=this;this.children.push(child);}}
  appendChild(child){this.append(child);return child;}
  remove(){if(this.parentElement){const siblings=this.parentElement.children;const i=siblings.indexOf(this);if(i>=0)siblings.splice(i,1);}this.parentElement=null;}
  before(child){const p=this.parentElement;if(!p)throw Error('Missing parent');child.remove();child.parentElement=p;p.children.splice(p.children.indexOf(this),0,child);}
  replaceChildren(...children){for(const c of this.children)c.parentElement=null;this.children=[];this._text='';this.append(...children);}
  set textContent(v){this.replaceChildren();this._text=String(v);}
  get textContent(){return this._text+this.children.map(c=>c.textContent).join('');}
  set innerHTML(html){this.replaceChildren();const stack=[this];for(const token of html.match(/<[^>]+>|[^<]+/g)||[]){if(token.startsWith('</')){stack.pop();continue;}if(token.startsWith('<')){const tag=token.match(/^<([\w-]+)/)?.[1];if(!tag)continue;const e=new Element(tag,this.ownerDocument);for(const m of token.matchAll(/([\w-]+)(?:="([^"]*)"|='([^']*)')?/g)){if(m.index===1)continue;e.setAttribute(m[1],m[2]??m[3]??'');}stack.at(-1).append(e);if(!['input','br','img','hr'].includes(tag)&&!token.endsWith('/>'))stack.push(e);}else stack.at(-1)._text+=token;}}
  matches(selector){if(selector.includes(','))return selector.split(',').some(s=>this.matches(s.trim()));if(selector.startsWith('#'))return this.id===selector.slice(1);if(selector.startsWith('.'))return this.className.split(/\s+/).includes(selector.slice(1));const attr=selector.match(/^\[([^=\]]+)(?:="?([^"\]]+)"?)?\]$/);if(attr){const value=attr[1].startsWith('data-')?this.dataset[camel(attr[1].slice(5))]:this.attributes[attr[1]];return value!==undefined&&(attr[2]===undefined||value===attr[2]);}return this.tagName===selector.toUpperCase();}
  querySelectorAll(selector){const split=selector.lastIndexOf(' ');if(split>=0)return this.querySelectorAll(selector.slice(0,split)).flatMap(e=>e.querySelectorAll(selector.slice(split+1)));const out=[];for(const c of this.children){if(c.matches(selector))out.push(c);out.push(...c.querySelectorAll(selector));}return out;}
  querySelector(selector){return this.querySelectorAll(selector)[0]||null;}
  closest(selector){for(let node=this;node;node=node.parentElement)if(node.matches(selector))return node;return null;}
  addEventListener(name,fn){(this.listeners[name]??=[]).push(fn);}
  dispatch(name,props={}){const event={type:name,target:this,currentTarget:this,isComposing:false,preventDefault(){},...props};for(const fn of this.listeners[name]||[])fn(event);if(typeof this['on'+name]==='function')return this['on'+name](event);}
  focus(){this.ownerDocument.activeElement=this;}
}
function dom(){const d={activeElement:null,hidden:false};d.head=new Element('head',d);d.body=new Element('body',d);d.createElement=tag=>new Element(tag,d);d.querySelectorAll=s=>[d.head,d.body].flatMap(r=>r.querySelectorAll(s));d.querySelector=s=>d.querySelectorAll(s)[0]||null;d.getElementById=id=>d.querySelector('#'+id);d.body.innerHTML='<aside id="inspector"><div><label>メモ</label><textarea id="memo"></textarea></div><textarea id="frRecordMemo"></textarea><input id="damageType"><input id="member"><input id="lineWidth"><div class="photo-panel"></div></aside><button id="deleteBtn"></button><button id="undoBtn"></button><button id="redoBtn"></button>';return d;}
const shape=(id='s1')=>C.upgrade({id,kind:'polyline',page:1,type:'ひび割れ',member:'主桁',points:[{x:10,y:20},{x:30,y:40}],memo:'既存記録',photos:[],crackWidthMm:0.2});
let generatedIds=0;
function fixture({shapes=[shape()],storage=new Map(),savedState,account='account-a'}={}){
  const document=dom(),records=new Map(),microtasks=[],timers=new Map();let clock=1000,timerId=0,writes=0,failure=false,user=account;
  const initial=savedState||{currentPage:1,shapes:copy(shapes),collabDeletedRecords:[]};records.set('draw:d1',JSON.stringify(initial));
  class ClockDate extends Date{static now(){return clock;}}
  const ctx={console,Blob,Date:ClockDate,JSON,Map,Set,Number,Promise,Error,document,navigator:{onLine:true,userAgent:'iPhone',maxTouchPoints:1},crypto:{randomUUID:()=>`uuid-${++generatedIds}`},
    localStorage:{getItem:k=>storage.get(k)??null,setItem:(k,v)=>storage.set(k,String(v)),removeItem:k=>storage.delete(k)},
    setTimeout:(fn,ms)=>{const i=++timerId;timers.set(i,{at:clock+ms,fn});return i;},clearTimeout:i=>timers.delete(i),queueMicrotask:fn=>microtasks.push(fn),
    SentlogRecords:{getItem:k=>records.get(k)??null,setItem:(k,v)=>records.set(k,v)},drawingStorageKey:id=>'draw:'+id,
    activeProjectId:'p1',activeDrawingId:'d1',currentView:'editor',selected:initial.shapes[0]?.id||null,state:copy(initial),
    sentlogCollaborationAccountId:()=>user,sentlogCollabRefresh:async projectId=>({fresh:true,projectId}),addEventListener:()=>{},
    persist:()=>{if(failure){failure=false;throw Error('保存失敗');}writes++;records.set('draw:'+ctx.activeDrawingId,JSON.stringify(ctx.state));},
    rebuildNumberingState:()=>{},render:()=>{},renderSelectedPhotos:()=>{},clearAllHistory:()=>{},undo:()=>{},redo:()=>{},updateHistoryButtons:()=>{},pushHistory:()=>{},selectedShape:()=>ctx.state.shapes.find(s=>s.id===ctx.selected)||null,
    selectShape:id=>{ctx.selected=id;ctx.render();}};
  ctx.window=ctx;vm.createContext(ctx);vm.runInContext(modelCode,ctx);vm.runInContext(legacyPhotoRemove,ctx);vm.runInContext(editorCode,ctx);
  const api=ctx.SentlogCollaboration,input=document.getElementById('slCollabDraft'),panel=document.getElementById('slCollabComments');
  function drain(){let n=0;while(microtasks.length){if(++n>100)throw Error('Microtask loop');microtasks.shift()();}}
  function tick(ms){const end=clock+ms;for(;;){drain();const next=[...timers.entries()].filter(([,v])=>v.at<=end).sort((a,b)=>a[1].at-b[1].at)[0];if(!next)break;clock=next[1].at;timers.delete(next[0]);next[1].fn();}clock=end;drain();}
  function type(text,props){input.value=text;input.dispatch('input',props);}
  function buttons(label,root=document.body){return root.querySelectorAll('button').filter(b=>b.textContent===label);}
  async function click(label,root=document.body){const b=buttons(label,root).find(x=>!x.disabled);assert(b,'Missing enabled button: '+label);const result=b.onclick?.();drain();await result;drain();}
  function receive(record){ctx.state.shapes=ctx.state.shapes.map(s=>s.id===record.id?copy(record):s);records.set('draw:'+ctx.activeDrawingId,JSON.stringify(ctx.state));api.onRemote();drain();}
  return {ctx,api,input,panel,document,records,storage,drain,tick,type,click,buttons,receive,get writes(){return writes;},get current(){return ctx.state.shapes.find(s=>s.id===ctx.selected);},get note(){return panel.querySelector('[data-note]').textContent;},failNextWrite(){failure=true;},setAccount(v){user=v;},state(){return copy(ctx.state);}};
}
const remoteOpts=prefix=>{let n=0;return {actor:{deviceId:prefix,deviceName:prefix},at:500,idFactory:()=>prefix+'-'+(++n)};};
let passed=0;async function test(name,fn){await fn();passed++;console.log('PASS '+name);}
(async()=>{
await test('autosave appends an independent comment, keeps a stable device, and next draft does not overwrite it',async()=>{
  const f=fixture(),device=f.api.actor().deviceId;f.type('一つ目の追記');f.tick(649);assert.equal(f.writes,0);f.tick(1);assert.equal(f.writes,1);
  assert.equal(C.view(f.current).comments.length,2);assert.equal(f.current.memo,'既存記録\n\n一つ目の追記');
  f.type('一つ目の追記を完成');f.tick(650);assert.equal(C.view(f.current).comments.length,2);
  await f.click('次のコメント',f.panel);assert.equal(f.input.value,'');f.type('二つ目');f.tick(650);assert.equal(C.view(f.current).comments.length,3);
  const reopened=fixture({storage:f.storage,savedState:f.state()});assert.equal(reopened.api.actor().deviceId,device);assert.equal(reopened.writes,0);assert.equal(reopened.input.value,'');
  reopened.type('再読み込み後の追記');reopened.tick(650);assert.equal(C.view(reopened.current).comments.length,4);assert(C.view(reopened.current).comments.some(c=>c.text==='二つ目'));
  assert.equal(f.document.getElementById('memo').readOnly,true);assert.equal(f.document.getElementById('frRecordMemo').readOnly,true);
});

await test('returning to a completed record starts a fresh comment while active autosave and redraw keep the current composer',async()=>{
  const f=fixture({shapes:[shape('s1'),shape('s2')]});f.type('継続中の文章');f.api.flushDraft();const entry=C.view(f.current).comments.at(-1),originalId=entry.id;
  f.ctx.render();f.api.onRemote();assert.equal(f.input.value,'継続中の文章');f.type('継続して完成');f.tick(650);
  assert.equal(C.view(f.current).comments.length,2);assert.equal(C.view(f.current).comments.find(c=>c.id===originalId).text,'継続して完成');
  f.ctx.selectShape('s2');f.ctx.selectShape('s1');assert.equal(f.input.value,'');assert.equal(f.panel.querySelector('[data-draft-label]').textContent,'コメントを追記');
  f.type('再訪後の独立した文章');f.tick(650);assert.equal(C.view(f.current).comments.length,3);assert.equal(C.view(f.current).comments.find(c=>c.id===originalId).text,'継続して完成');
  assert.notEqual(C.view(f.current).comments.at(-1).id,originalId);
});

await test('reload restores pending and failed drafts with their exact text and operation identity',async()=>{
  for(const fail of [false,true]){
    const f=fixture();f.type(fail?'保存失敗した文章':'まだ自動保存前の文章');if(fail){f.failNextWrite();assert.equal(f.api.flushDraft(),false);}
    const stored=JSON.parse([...f.storage].find(([k])=>k.startsWith('sentlogCollaborativeDraftV1:'))[1]);
    const reopened=fixture({storage:f.storage,savedState:f.state()});assert.equal(reopened.input.value,stored.text);assert.equal(reopened.writes,0);reopened.tick(250);
    const entry=C.view(reopened.current).comments.find(c=>c.id===stored.commentId);assert(entry);assert.equal(entry.text,stored.text);
    if(fail)assert.equal(entry.headIds[0],stored.revisionId,'a failed operation replays with the same revision ID');
    assert.equal(C.view(reopened.current).comments.length,2);
  }
});

await test('reopened unfinished IME text is retained exactly and never automatically committed as completed text',async()=>{
  const f=fixture();f.type('保存済みの文章');f.api.flushDraft();const commentId=C.view(f.current).comments.at(-1).id;
  f.input.dispatch('compositionstart');f.type('変換とちゅう',{isComposing:true});const reopened=fixture({storage:f.storage,savedState:f.state()});
  assert.equal(reopened.input.value,'変換とちゅう');assert.equal(reopened.api.hasPendingDraft(),true);reopened.tick(5000);assert.equal(reopened.writes,0);assert.equal(reopened.api.flushDraft(),false);
  reopened.type('変換を確定した文章');reopened.tick(650);assert.equal(C.view(reopened.current).comments.find(c=>c.id===commentId).text,'変換を確定した文章');assert.equal(C.view(reopened.current).comments.length,2);
  const same=fixture();same.type('変換開始前と同じ文字');same.api.flushDraft();same.input.dispatch('compositionstart');const unchanged=fixture({storage:same.storage,savedState:same.state()});
  assert.equal(unchanged.input.value,'変換開始前と同じ文字','an IME draft is not considered completed merely because its text still equals savedText');assert.equal(unchanged.api.hasPendingDraft(),true);
  await unchanged.click('保存',unchanged.panel);assert.equal(unchanged.api.hasPendingDraft(),false);
});

await test('savedText alone cannot discard a draft when its record write is missing after reload',async()=>{
  const f=fixture(),before=f.state();f.type('復旧が必要な文章');f.api.flushDraft();const commentId=C.view(f.current).comments.at(-1).id;
  const reopened=fixture({storage:f.storage,savedState:before});assert.equal(reopened.input.value,'復旧が必要な文章');reopened.tick(250);
  assert.equal(C.view(reopened.current).comments.find(c=>c.id===commentId).text,'復旧が必要な文章');
});

await test('explicit comment editing still edits the chosen entry and a later visit returns to independent append mode',async()=>{
  const f=fixture({shapes:[shape('s1'),shape('s2')]}),id=C.view(f.current).comments[0].id;
  await f.click('修正',f.panel);await f.click('修正する',f.document.querySelector('.sl-collab-dialog'));assert.equal(f.panel.querySelector('[data-draft-label]').textContent,'コメントを修正');
  f.type('確認して修正した文章');f.tick(650);assert.equal(C.view(f.current).comments.length,1);assert.equal(C.view(f.current).comments[0].id,id);assert.equal(C.view(f.current).comments[0].text,'確認して修正した文章');
  f.ctx.selectShape('s2');f.ctx.selectShape('s1');assert.equal(f.input.value,'');assert.equal(f.panel.querySelector('[data-draft-label]').textContent,'コメントを追記');
});

await test('failed autosave keeps a pending durable draft and retries once without duplicate entries',async()=>{
  const f=fixture();f.type('消えてはいけない下書き');f.failNextWrite();assert.equal(f.api.flushDraft(),false);assert.equal(f.current.memo,'既存記録');assert.equal(f.input.value,'消えてはいけない下書き');
  assert(f.note.includes('保存失敗'));f.tick(1000);assert.equal(f.api.flushDraft(),true);assert.equal(C.view(f.current).comments.length,2);assert.equal(f.current.memo,'既存記録\n\n消えてはいけない下書き');
  assert.equal(f.api.flushDraft(),false);assert.equal(C.view(f.current).comments.length,2);
});

await test('IME composition never saves a partial value and stays bound to the original record during selection change',async()=>{
  const f=fixture({shapes:[shape('s1'),shape('s2')]});f.input.dispatch('compositionstart');f.type('にゅうりょく',{isComposing:true});f.tick(5000);assert.equal(f.writes,0);
  f.ctx.selectShape('s2');assert.equal(f.input.value,'にゅうりょく');f.input.value='入力完了';f.input.dispatch('compositionend');f.type('入力完了');f.drain();
  assert(f.ctx.state.shapes.find(s=>s.id==='s1').memo.includes('入力完了'));assert.equal(f.ctx.state.shapes.find(s=>s.id==='s2').memo,'既存記録');assert.equal(f.input.value,'');
  f.type('別の記録');f.tick(650);assert(f.current.memo.includes('別の記録'));
});

await test('incoming peer comments preserve the exact unsaved local text and both save independently',async()=>{
  const f=fixture();f.type('入力途中');const peer=C.appendComment(f.current,'相手の記録',remoteOpts('Peer'));f.receive(peer);
  assert.equal(f.input.value,'入力途中');assert(f.current.memo.includes('相手の記録'));assert.equal(f.api.flushDraft(),true);
  assert(f.current.memo.includes('入力途中')&&f.current.memo.includes('相手の記録'));assert.equal(C.view(f.current).comments.length,3);
});

await test('stale drafts are retained and can be copied into a new comment without replacing a peer edit',async()=>{
  const f=fixture();f.type('自分のコメント');f.api.flushDraft();const own=C.view(f.current).comments.at(-1),peer=C.editComment(f.current,own.id,'相手が修正',{...remoteOpts('Peer'),expectedHeads:own.headIds});
  f.receive(peer);f.type('保存したい別の文章');assert.equal(f.api.flushDraft(),false);assert.equal(f.input.value,'保存したい別の文章');
  await f.click('別のコメントとして追記',f.panel);assert(f.current.memo.includes('相手が修正')&&f.current.memo.includes('保存したい別の文章'));
});

await test('existing scalar changes wait for fresh revision-bound confirmation and simultaneous field warnings are retained',async()=>{
  const f=fixture(),member=f.document.getElementById('member');member.value='横桁';assert.equal(f.api.isCapturedFieldDraft(member,f.current),false);f.current.crackWidthMm=0.3;f.current.member='横桁';f.ctx.persist();f.drain();
  assert.equal(f.current.crackWidthMm,0.2);assert.equal(f.current.member,'主桁');assert.equal(f.writes,1);
  assert.equal(f.api.isCapturedFieldDraft(member,f.current),true);member.value='未保存の別文';assert.equal(f.api.isCapturedFieldDraft(member,f.current),false);member.value='横桁';
  await f.click('変更する',f.document.querySelector('.sl-collab-dialog'));assert.equal(f.current.crackWidthMm,0.3);assert.equal(f.current.member,'主桁');
  await f.click('変更する',f.document.querySelector('.sl-collab-dialog'));assert.equal(f.current.member,'横桁');
  assert.equal(f.document.querySelector('.sl-collab-dialog').hidden,true);
});

await test('a peer edit during confirmation forces a second confirmation of the new head',async()=>{
  const f=fixture();f.current.crackWidthMm=0.3;f.ctx.persist();f.drain();let calls=0;
  f.ctx.sentlogCollabRefresh=async projectId=>{if(++calls===1)f.receive(C.setField(f.current,'crackWidthMm',0.4,{...remoteOpts('Peer'),expectedHeads:C.view(f.current).fields.crackWidthMm.headIds}));return {fresh:true,projectId};};
  await f.click('変更する',f.document.querySelector('.sl-collab-dialog'));assert.equal(f.current.crackWidthMm,0.4);assert(f.document.querySelector('[data-status]').textContent.includes('もう一度'));
  await f.click('変更する',f.document.querySelector('.sl-collab-dialog'));assert.equal(f.current.crackWidthMm,0.3);
});

await test('async confirmations do not mutate after selection or account changes, or a deferred refresh',async()=>{
  for(const change of ['selection','account','not-fresh']){
    const f=fixture({shapes:[shape('s1'),shape('s2')]});f.current.crackWidthMm=0.3;f.ctx.persist();f.drain();let done;
    f.ctx.sentlogCollabRefresh=()=>new Promise(resolve=>{done=resolve;});const pending=f.click('変更する',f.document.querySelector('.sl-collab-dialog'));
    if(change==='selection')f.ctx.selectShape('s2');if(change==='account')f.setAccount('account-b');done(change==='not-fresh'?{started:false}:{fresh:true,projectId:'p1'});await pending;
    assert.equal(f.ctx.state.shapes.find(s=>s.id==='s1').crackWidthMm,0.2,change);assert.equal(f.ctx.state.shapes.find(s=>s.id==='s2').crackWidthMm,0.2,change);
  }
});

await test('explicit model operations are not reinterpreted as new guarded scalar writes',async()=>{
  const f=fixture(),before=copy(f.current),next=C.setField(before,'crackWidthMm',0.5,{...remoteOpts('Explicit'),expectedHeads:C.view(before).fields.crackWidthMm.headIds});
  f.ctx.state.shapes[0]=next;f.ctx.persist();f.drain();assert.equal(f.current.crackWidthMm,0.5);assert.equal(f.document.querySelector('.sl-collab-dialog'),null);
  const persisted=copy(f.current),stale=copy(before);stale.points[0].x=99;f.ctx.state.shapes[0]=stale;f.records.set('draw:d1',JSON.stringify({...f.state(),shapes:[persisted]}));f.ctx.persist();f.drain();
  assert.equal(f.current.crackWidthMm,0.5,'unchanged stale raw scalar is not a new write');assert.equal(f.document.querySelector('.sl-collab-dialog'),null);assert.equal(f.current.points[0].x,99);
});

await test('undo and redo affect the local comment while preserving comments and photos received from peers',async()=>{
  const f=fixture();f.type('自分の追記');f.api.flushDraft();const peerOptions=remoteOpts('Peer');let remote=C.appendComment(f.current,'相手の追記',peerOptions);remote=C.addPhoto(remote,{id:'peer-photo',name:'相手.jpg'},peerOptions);f.receive(remote);
  f.ctx.undo();f.drain();assert(!f.current.memo.includes('自分の追記'));assert(f.current.memo.includes('相手の追記'));assert.equal(f.current.photos[0].id,'peer-photo');
  f.ctx.redo();f.drain();assert(f.current.memo.includes('自分の追記')&&f.current.memo.includes('相手の追記'));assert.equal(f.current.photos[0].id,'peer-photo');
});

await test('photo undo and redo use explicit observed removal and restoration while peer photos remain',async()=>{
  const f=fixture();f.ctx.state.shapes[0]=C.addPhoto(f.current,{id:'own-photo',name:'自分.jpg'},remoteOpts('Own'));f.ctx.persist();
  f.receive(C.addPhoto(f.current,{id:'peer-photo',name:'相手.jpg'},remoteOpts('Peer')));f.ctx.undo();f.drain();assert.deepEqual(Array.from(f.current.photos,p=>p.id),['peer-photo']);
  f.ctx.redo();f.drain();assert.deepEqual(new Set(f.current.photos.map(p=>p.id)),new Set(['own-photo','peer-photo']));
});

await test('the existing photo remove handler confirms an observed unlink and undo retains a peer photo added meanwhile',async()=>{
  const initial=C.addPhoto(shape(),{id:'photo-a',name:'外す写真.jpg'},remoteOpts('Initial')),f=fixture({shapes:[initial]});
  await f.ctx.removeSelectedPhoto('photo-a');f.drain();assert.equal(f.current.photos.length,1,'thumbnail × must not remove a photo before confirmation');
  f.receive(C.addPhoto(f.current,{id:'peer-photo',name:'確認中に届いた写真.jpg'},remoteOpts('Peer')));
  await f.click('写真を外す',f.document.querySelector('.sl-collab-dialog'));assert.deepEqual(Array.from(f.current.photos,p=>p.id),['peer-photo']);assert(C.view(f.current).photos.find(p=>p.id==='photo-a').deleted);
  assert.equal(f.current.collab.photos['photo-a'].revisions.length,2,'unlink retains the original metadata revision');f.ctx.undo();f.drain();
  assert.deepEqual(new Set(f.current.photos.map(p=>p.id)),new Set(['photo-a','peer-photo']));assert.equal(f.current.photos.find(p=>p.id==='photo-a').name,'外す写真.jpg');
});

await test('two pending photo removals keep separate identities and both remain confirmable',async()=>{
  const o=remoteOpts('Initial');let initial=C.addPhoto(shape(),{id:'photo-a',name:'A.jpg'},o);initial=C.addPhoto(initial,{id:'photo-b',name:'B.jpg'},o);const f=fixture({shapes:[initial]});
  await f.ctx.removeSelectedPhoto('photo-a');await f.ctx.removeSelectedPhoto('photo-b');f.drain();assert.equal(f.current.photos.length,2);
  assert(f.document.querySelector('[data-summary]').textContent.includes('A.jpg'));await f.click('写真を外す',f.document.querySelector('.sl-collab-dialog'));
  assert.deepEqual(Array.from(f.current.photos,p=>p.id),['photo-b']);assert(f.document.querySelector('[data-summary]').textContent.includes('B.jpg'));await f.click('写真を外す',f.document.querySelector('.sl-collab-dialog'));
  assert.equal(f.current.photos.length,0);assert.equal(Object.keys(f.current.collab.photos).length,2);
});

await test('a changed photo head requires review again and an account change cancels the pending unlink',async()=>{
  const initial=C.addPhoto(shape(),{id:'photo-a',name:'最初の名前.jpg'},remoteOpts('Initial')),f=fixture({shapes:[initial]});await f.ctx.removeSelectedPhoto('photo-a');f.drain();let pulls=0;
  f.ctx.sentlogCollabRefresh=async projectId=>{if(++pulls===1){const row=C.view(f.current).photos.find(p=>p.id==='photo-a');f.receive(C.restorePhoto(f.current,'photo-a',{...remoteOpts('Peer'),expectedHeads:row.headIds,metadata:{...row.metadata,name:'更新された名前.jpg'}}));}return {fresh:true,projectId};};
  await f.click('写真を外す',f.document.querySelector('.sl-collab-dialog'));assert.equal(f.current.photos.length,1);assert(f.document.querySelector('[data-status]').textContent.includes('もう一度'));assert(f.document.querySelector('[data-summary]').textContent.includes('更新された名前.jpg'));
  await f.click('写真を外す',f.document.querySelector('.sl-collab-dialog'));assert.equal(f.current.photos.length,0);
  const other=fixture({shapes:[initial]});await other.ctx.removeSelectedPhoto('photo-a');let done;other.ctx.sentlogCollabRefresh=()=>new Promise(resolve=>{done=resolve;});const pending=other.click('写真を外す',other.document.querySelector('.sl-collab-dialog'));
  other.setAccount('other-account');done({fresh:true,projectId:'p1'});await pending;assert.equal(other.current.photos.length,1);assert.equal(other.writes,0);
});

await test('undo skips a field that a peer changed after the local decision',async()=>{
  const f=fixture();f.current.crackWidthMm=0.3;f.ctx.persist();f.drain();await f.click('変更する',f.document.querySelector('.sl-collab-dialog'));
  f.receive(C.setField(f.current,'crackWidthMm',0.8,{...remoteOpts('Peer'),expectedHeads:C.view(f.current).fields.crackWidthMm.headIds}));f.ctx.undo();f.drain();assert.equal(f.current.crackWidthMm,0.8);assert(f.note.includes('保護'));
});

await test('a local scalar decision supports undo and redo with new revision heads',async()=>{
  const f=fixture();f.current.crackWidthMm=0.3;f.ctx.persist();f.drain();await f.click('変更する',f.document.querySelector('.sl-collab-dialog'));
  f.ctx.undo();f.drain();assert.equal(f.current.crackWidthMm,0.2);f.ctx.redo();f.drain();assert.equal(f.current.crackWidthMm,0.3);f.ctx.undo();f.drain();assert.equal(f.current.crackWidthMm,0.2);
});

await test('record deletion retains complete history and undo restores that exact tombstone',async()=>{
  const f=fixture();f.type('削除前の追記');f.api.flushDraft();await f.document.getElementById('deleteBtn').onclick();await f.click('削除する',f.document.querySelector('.sl-collab-dialog'));
  assert.equal(f.ctx.state.shapes.length,0);assert.equal(f.ctx.state.collabDeletedRecords.length,1);assert(f.ctx.state.collabDeletedRecords[0].memo.includes('削除前の追記'));
  f.ctx.undo();f.drain();assert.equal(f.ctx.state.shapes.length,1);assert.equal(f.ctx.state.collabDeletedRecords.length,0);assert(f.ctx.state.shapes[0].memo.includes('削除前の追記'));
});

await test('legacy textarea disappearance cannot erase existing memo or silently delete a record',async()=>{
  const f=fixture();f.current.memo='';f.ctx.persist();assert.equal(f.current.memo,'既存記録');f.ctx.state.shapes=[];f.ctx.persist();assert.equal(f.ctx.state.shapes[0].memo,'既存記録');
});

await test('unselected drawing-memo deletion becomes a reviewable decision without switching modes or moving records',async()=>{
  const memo=C.upgrade({id:'memo',kind:'memo',recordKind:'drawing-memo',memoType:'text',page:1,points:[{x:50,y:60}],text:'注記',photos:[]}),f=fixture({shapes:[memo]});
  f.ctx.selected=null;f.api.refresh();const geometry=copy(f.ctx.state.shapes[0].points);f.ctx.state.shapes=[];f.ctx.persist();f.drain();
  assert.equal(f.ctx.state.shapes.length,1);assert.deepEqual(copy(f.ctx.state.shapes[0].points),geometry);assert.equal(f.ctx.selected,null);assert.equal(f.document.querySelector('.sl-collab-dialog'),null);
  const entry=f.document.getElementById('slCollabReviewButton');assert.equal(entry.hidden,false);assert(entry.textContent.includes('1件'));entry.onclick();
  await f.click('変更内容を確認',f.document.querySelector('.sl-collab-review'));await f.click('削除する',f.document.querySelector('.sl-collab-dialog'));
  assert.equal(f.ctx.selected,null);assert.equal(f.ctx.state.shapes.length,0);assert.equal(f.ctx.state.collabDeletedRecords[0].id,'memo');assert.deepEqual(copy(f.ctx.state.collabDeletedRecords[0].points),geometry);
});

await test('unselected dimension changes and geometry conflicts are accessible through global review',async()=>{
  const dimension=C.upgrade({id:'dimension',kind:'dimension',recordKind:'dimension-line',page:1,points:[{x:10,y:20},{x:30,y:40}],manualText:'1.0 m',photos:[]});
  const f=fixture({shapes:[dimension]});f.ctx.selected=null;f.api.refresh();f.ctx.state.shapes[0].manualText='2.0 m';f.ctx.persist();f.drain();
  assert.equal(f.ctx.state.shapes[0].manualText,'1.0 m');f.document.getElementById('slCollabReviewButton').onclick();await f.click('変更内容を確認',f.document.querySelector('.sl-collab-review'));await f.click('変更する',f.document.querySelector('.sl-collab-dialog'));
  assert.equal(f.ctx.state.shapes[0].manualText,'2.0 m');assert.equal(f.ctx.selected,null);
  const base=f.ctx.state.shapes[0],left=copy(C.view(base).fields.geometry.value),right=copy(left);left.points[0].x=99;right.points[0].x=77;
  const a=C.setField(base,'geometry',left,{...remoteOpts('Left'),expectedHeads:C.view(base).fields.geometry.headIds});
  const b=C.setField(base,'geometry',right,{...remoteOpts('Right'),expectedHeads:C.view(base).fields.geometry.headIds});f.receive(C.mergeRecords(a,b,{base}).record);
  f.document.getElementById('slCollabReviewButton').onclick();const review=f.document.querySelector('.sl-collab-review');assert(review.textContent.includes('変更前の共通'));await f.click('この内容を採用',review);
  assert.equal(C.view(f.ctx.state.shapes[0]).fields.geometry.conflict,false);assert.equal(f.ctx.selected,null);
});

await test('old-client raw memo is visible before cloud initialization and normalization preserves drafts and previews',async()=>{
  const raw=shape();raw.memo='旧版で入力した未正規化の文章';const initial={currentPage:1,shapes:[raw],collabDeletedRecords:[]},f=fixture({savedState:initial});
  assert(f.panel.querySelector('[data-list]').textContent.includes(raw.memo),'a pure presentation view shows legacy raw text before cloud globals exist');assert.equal(f.writes,0,'render must never persist a migration');
  f.type('現在の下書き');const normalized=C.applyLocalEdit(C.upgrade(raw),raw,{deterministic:true,recordId:raw.id,actor:{deviceId:null,deviceName:'不明'},at:0});
  const next={...copy(initial),shapes:[normalized]},oldText=JSON.stringify(initial),nextText=JSON.stringify(next);f.records.set('draw:d1',nextText);f.api.afterStoredNormalization([['draw:d1',nextText]],[['draw:d1',oldText]]);
  assert.equal(C.view(f.current).comments.length,2);assert.equal(f.input.value,'現在の下書き');assert.equal(f.writes,0);
  assert(f.api.flushDraft());assert.equal(C.view(f.current).comments.length,3);
  const preview=fixture({savedState:initial});preview.current.points[0].x=123;preview.records.set('draw:d1',nextText);preview.api.afterStoredNormalization([['draw:d1',nextText]],[['draw:d1',oldText]]);
  assert.equal(preview.current.points[0].x,123,'normalization cannot replace an active geometry preview');preview.ctx.persist();preview.drain();assert.equal(C.view(preview.current).comments.filter(c=>c.text===raw.memo).length,1);
});

await test('switching to edit another comment cannot discard an unsaved stale draft',async()=>{
  const f=fixture();f.type('自分の追記');f.api.flushDraft();const own=C.view(f.current).comments.at(-1),peer=C.editComment(f.current,own.id,'相手が変更',{...remoteOpts('Peer'),expectedHeads:own.headIds});f.receive(peer);f.type('残すべき未保存文');
  await f.click('修正',f.panel);await f.click('修正する',f.document.querySelector('.sl-collab-dialog'));assert.equal(f.input.value,'残すべき未保存文');assert(f.document.querySelector('[data-status]').textContent.includes('先に保存'));
});
console.log(passed+' collaborative editor scenarios passed');
})().catch(e=>{console.error(e);process.exitCode=1;});

"""Browser check for v1.69 drawing-list rename/delete actions. Synthetic records only."""
import os
from pathlib import Path
from playwright.sync_api import sync_playwright

ROOT=Path(__file__).resolve().parents[1]
BASE='''<!doctype html><html lang="ja"><meta charset="UTF-8"><style>
.manager-grid{display:grid;grid-template-columns:repeat(2,280px);gap:10px}.manager-card{border:1px solid #ddd;border-radius:10px;padding:12px}.manager-card-title{font-weight:700}.manager-card-meta{font-size:12px}.manager-card-bottom{display:flex;gap:8px}
</style><body>
<div id="drawingsGrid" class="manager-grid"></div><div id="drawingsEmpty"></div><div id="drawingProjectTitle"></div><div id="drawingProjectSummary"></div>
<script>
let currentView='drawings',activeProjectId='p1',activeDrawingId=null,opened=[],alerts=[],confirmText='',renamedOriginals=[],originalRefresh=0;
let workspace={projects:[{id:'p1',name:'試験案件',updatedAt:2,drawings:[
 {id:'d1',name:'図面A',fileName:'a.pdf',sourceType:'pdf',pageCount:2,shapeCount:3,photoCount:1,updatedAt:1},
 {id:'d2',name:'図面B',fileName:'b.pdf',sourceType:'pdf',pageCount:1,shapeCount:4,photoCount:2,updatedAt:2}
]}]};
const records=new Map([
 ['surveyFieldNoteWorkspaceV1',JSON.stringify(workspace)],
 ['surveyFieldNoteDrawingV1:d1',JSON.stringify({shapes:[{photos:[{id:'p1'}]}]})],
 ['surveyFieldNoteDrawingV1:d2',JSON.stringify({shapes:[{photos:[{id:'p2'},{id:'p3'}]}]})]
]);
const files=new Map([
 ['background:d1',new Blob(['drawing-a'])],['photo:d1:p1',new Blob(['one'])],
 ['background:d2',new Blob(['drawing-b'])],['photo:d2:p2',new Blob(['two'])],['photo:d2:p3',new Blob(['three'])]
]);
const SentlogRecords={
 getItem(k){return records.get(k)??null},
 async archiveAtomic({writes,deleteFiles,expectedWorkspace}){
   if(records.get('surveyFieldNoteWorkspaceV1')!==expectedWorkspace)throw Error('workspace changed');
   for(const f of deleteFiles){const v=files.get(f.key);if(!(v instanceof Blob)||v.size!==f.size)throw Error('file changed '+f.key)}
   for(const f of deleteFiles)files.delete(f.key);
   for(const [k,v] of writes){if(v===null)records.delete(k);else records.set(k,v)}
 }
};
window.SentlogRecords=SentlogRecords;
window.SentlogOriginalPhotos={
 async drawingStats(id){return id==='d2'?{count:2,unexportedCount:1,bytes:100,unexportedBytes:50}:{count:1,unexportedCount:0,bytes:20,unexportedBytes:0}},
 async renameDrawing(id,name){renamedOriginals.push([id,name]);return 1},
 refreshUI(){originalRefresh++}
};
function drawingStorageKey(id){return 'surveyFieldNoteDrawingV1:'+id}
function getProject(id=activeProjectId){return workspace.projects.find(p=>p.id===id)||null}
function nowText(){return '今'}
async function getAllDBFiles(){return [...files].map(([key,value])=>({key,value}))}
function openDrawing(projectId,drawingId){opened.push([projectId,drawingId])}
function renderDrawings(){
 const p=getProject();const grid=document.getElementById('drawingsGrid');grid.innerHTML='';
 const items=p.drawings||[];document.getElementById('drawingsEmpty').classList.toggle('hidden',items.length>0);
 items.slice().sort((a,b)=>(b.updatedAt||0)-(a.updatedAt||0)).forEach(d=>{
   const card=document.createElement('div');card.className='manager-card';card.tabIndex=0;
   const title=document.createElement('div');title.className='manager-card-title';title.textContent=d.name;
   const file=document.createElement('div');file.className='manager-card-meta';file.textContent=d.fileName;
   const bottom=document.createElement('div');bottom.className='manager-card-bottom';bottom.textContent=(d.shapeCount||0)+'件';
   card.append(title,file,bottom);card.onclick=()=>openDrawing(p.id,d.id);card.onkeydown=e=>{if(e.key==='Enter'||e.key===' ')card.click()};grid.appendChild(card);
 });
}
window.prompt=()=>null;window.confirm=msg=>{confirmText=msg;return true};window.alert=msg=>alerts.push(msg);
renderDrawings();
</script></body></html>'''

with sync_playwright() as p:
    opts={'headless':True}
    if os.path.exists('/usr/bin/chromium'):
        opts.update(executable_path='/usr/bin/chromium',args=['--no-sandbox'])
    browser=p.chromium.launch(**opts)
    page=browser.new_page(viewport={'width':760,'height':800})
    errors=[]
    page.on('pageerror',lambda e: errors.append(str(e)))
    page.route('https://sentlog.test/',lambda route: route.fulfill(status=200,content_type='text/html',body=BASE))
    page.goto('https://sentlog.test/')
    page.add_script_tag(content=(ROOT/'sentlog/drawing-list-actions.js').read_text(encoding='utf-8'))

    assert page.locator('.manager-card').count()==2
    assert page.locator('.drawing-card-actions').count()==2
    assert page.locator('.drawing-card-actions button').count()==4

    # Ordinary card use still opens the drawing.
    page.locator('.manager-card[data-drawing-id="d1"] .manager-card-title').click()
    assert page.evaluate("opened")==[['p1','d1']]

    # Rename is an action, not a card-open; original-photo export metadata follows the new name.
    page.evaluate("opened=[];window.prompt=()=> '  図面A   改訂版  '")
    page.locator('.manager-card[data-drawing-id="d1"] .drawing-card-action.rename').click()
    page.wait_for_function("workspace.projects[0].drawings.find(d=>d.id==='d1').name==='図面A 改訂版'")
    assert page.evaluate("opened")==[]
    assert page.evaluate("renamedOriginals")==[['d1','図面A 改訂版']]
    assert page.locator('.manager-card[data-drawing-id="d1"] .manager-card-title').inner_text()=='図面A 改訂版'

    # Delete removes drawing state/background/shared photos but explicitly keeps originals.
    page.locator('.manager-card[data-drawing-id="d2"] .drawing-card-action.delete').click()
    page.wait_for_function("!workspace.projects[0].drawings.some(d=>d.id==='d2')")
    result=page.evaluate("""()=>({
      ids:workspace.projects[0].drawings.map(d=>d.id),
      stateD2:records.has('surveyFieldNoteDrawingV1:d2'),
      bgD2:files.has('background:d2'),p2:files.has('photo:d2:p2'),p3:files.has('photo:d2:p3'),
      bgD1:files.has('background:d1'),p1:files.has('photo:d1:p1'),
      confirmText,alerts,opened,originalRefresh
    })""")
    assert result['ids']==['d1'],result
    assert not result['stateD2'] and not result['bgD2'] and not result['p2'] and not result['p3'],result
    assert result['bgD1'] and result['p1'],result
    assert '原本写真 2枚はこの操作では削除しません' in result['confirmText'],result
    assert '未書き出し 1枚' in result['confirmText'],result
    assert any('原本写真 2枚は残しています' in x for x in result['alerts']),result
    assert result['opened']==[],result
    assert result['originalRefresh']>=2,result
    assert page.locator('.manager-card').count()==1
    assert not errors,errors

    (ROOT/'test-results').mkdir(exist_ok=True)
    page.screenshot(path=str(ROOT/'test-results/drawing-list-actions-ui.png'),full_page=True)
    browser.close()
    print('PASS drawing-list UI: rename does not open card; delete is confirmed, atomic, scoped to one drawing, originals preserved')

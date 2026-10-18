"""Browser check for v1.71 drawing-number groups with nested sheets. Synthetic data only."""
import os
from pathlib import Path
from playwright.sync_api import sync_playwright

ROOT=Path(__file__).resolve().parents[1]
BASE='''<!doctype html><html lang="ja"><meta charset="UTF-8"><style>
.manager-grid{display:grid;grid-template-columns:repeat(2,260px);gap:10px}.manager-card{border:1px solid #ddd;padding:10px;border-radius:10px}
.stack{display:grid;gap:8px;width:260px}.btn,button,select{min-height:40px}
</style><body>
<section id="projectsView"><div id="projectsGrid"></div></section>
<section id="drawingsView"><label class="btn" for="drawingAddInput">＋ PDF / 図面を追加</label><input id="drawingAddInput" type="file" hidden>
<div id="drawingProjectTitle"></div><div id="drawingProjectSummary"></div><div id="drawingsGrid" class="manager-grid"></div><div id="drawingsEmpty"></div></section>
<section id="editorView"><header><span id="headerTitle"></span></header><aside id="sidebar"><div id="drawingNameView"></div><div class="stack">
<button id="editorDrawingAddBtn">＋ 図面を追加</button><label class="btn" for="fileInput">この図面を差し替え</label><input id="fileInput" type="file" hidden><div id="fileName"></div>
</div></aside></section>
<script>
let currentView='drawings',activeProjectId='p1',activeDrawingId=null,selected=null,drawing=null,pdfDoc=null,state={};
let promptValue='',confirmValue=true,alerts=[],addInputClicks=0,persistCount=0,saveCount=0,openFileCount=0,idSeq=10;
let workspace={projects:[{id:'p1',name:'試験案件',updatedAt:10,drawings:[
 {id:'s1',name:'平面図',sheetName:'平面図',groupId:'g1',groupName:'図面No.1',sheetOrder:1,fileName:'plan.pdf',sourceType:'pdf',shapeCount:2,photoCount:1,createdAt:1,updatedAt:5},
 {id:'s2',name:'下流面',sheetName:'下流面',groupId:'g1',groupName:'図面No.1',sheetOrder:2,fileName:'down.pdf',sourceType:'pdf',shapeCount:3,photoCount:2,createdAt:2,updatedAt:7},
 {id:'s3',name:'断面図',sheetName:'断面図',groupId:'g2',groupName:'図面No.2',sheetOrder:1,fileName:'sec.pdf',sourceType:'pdf',shapeCount:1,photoCount:0,createdAt:3,updatedAt:6}
]}]};
const rec=new Map([['surveyFieldNoteWorkspaceV1',JSON.stringify(workspace)],['draw:s1','{}'],['draw:s2','{}'],['draw:s3','{}']]);
const files=new Map([['background:s1',new Blob(['1'])],['background:s2',new Blob(['2'])],['background:s3',new Blob(['3'])]]);
window.SentlogRecords={
 getItem:k=>rec.get(k)??null,setItem(k,v){rec.set(k,String(v))},
 async archiveAtomic({writes,deleteFiles,expectedWorkspace}){if(rec.get('surveyFieldNoteWorkspaceV1')!==expectedWorkspace)throw Error('workspace changed');for(const f of deleteFiles)files.delete(f.key);for(const [k,v] of writes){if(v===null)rec.delete(k);else rec.set(k,v)}},
};
window.SentlogOriginalPhotos={async drawingStats(){return {count:0,unexportedCount:0,bytes:0,unexportedBytes:0}},refreshUI(){}};
window.sentlogAppReady=Promise.resolve();
function drawingStorageKey(id){return 'draw:'+id}
function uid(){return 'n'+(++idSeq)}
function saveWorkspace(){SentlogRecords.setItem('surveyFieldNoteWorkspaceV1',JSON.stringify(workspace))}
function getProject(id=activeProjectId){return workspace.projects.find(p=>p.id===id)||null}
function getDrawingMeta(projectId=activeProjectId,drawingId=activeDrawingId){return getProject(projectId)?.drawings.find(d=>d.id===drawingId)||null}
function nowText(){return '今'}
function renderProjects(){document.getElementById('projectsGrid').textContent='projects'}
function renderDrawings(){document.getElementById('drawingsGrid').textContent='base'}
function showProjects(){currentView='projects'}
function showDrawings(projectId){activeProjectId=projectId;activeDrawingId=null;currentView='drawings';renderDrawings()}
function showEditor(){currentView='editor';const d=getDrawingMeta();document.getElementById('drawingNameView').textContent=d?.name||''}
async function openDrawing(projectId,drawingId){activeProjectId=projectId;activeDrawingId=drawingId;showEditor()}
function freshDrawingState(project){return {project,shapes:[],pageCount:1,currentPage:1}}
function clearAllHistory(){}
function persist(){persistCount++;if(activeDrawingId)rec.set(drawingStorageKey(activeDrawingId),JSON.stringify(state))}
async function saveBackgroundFile(file,id){saveCount++;files.set('background:'+id,file)}
async function openFile(file){openFileCount++;state.fileName=file.name}
async function getAllDBFiles(){return [...files].map(([key,value])=>({key,value}))}
async function createDrawingFromFile(file){throw Error('base create should be replaced')}
document.getElementById('drawingAddInput').addEventListener('click',e=>{e.preventDefault();addInputClicks++});
window.prompt=()=>promptValue;window.confirm=()=>confirmValue;window.alert=m=>alerts.push(m);
renderDrawings();
</script></body></html>'''

with sync_playwright() as p:
    opts={'headless':True}
    if os.path.exists('/usr/bin/chromium'):
        opts.update(executable_path='/usr/bin/chromium',args=['--no-sandbox'])
    browser=p.chromium.launch(**opts)
    page=browser.new_page(viewport={'width':760,'height':900})
    errors=[]
    page.on('pageerror',lambda e: errors.append(str(e)))
    page.route('https://sentlog.test/',lambda route: route.fulfill(status=200,content_type='text/html',body=BASE))
    page.goto('https://sentlog.test/')
    page.add_script_tag(content=(ROOT/'sentlog/drawing-groups.js').read_text(encoding='utf-8'))
    page.wait_for_timeout(30)

    # Drawing list is grouped: 3 sheet records render as 2 drawing-number cards.
    assert page.locator('.manager-card').count()==2
    assert page.locator('.manager-card').nth(0).locator('.manager-card-title').inner_text()=='図面No.1'
    assert '2シート' in page.locator('.manager-card').nth(0).locator('.drawing-group-sheets').inner_text()
    assert page.locator('#drawingProjectSummary').inner_text().endswith('図面No. 2件 / シート 3枚')
    assert page.locator('#drawingsView label[for="drawingAddInput"]').inner_text()=='＋ 新しい図面No.'

    # Open first group, then verify editor sheet navigation and corrected add semantics.
    page.locator('.manager-card[data-drawing-group-id="g1"] .manager-card-title').click()
    page.wait_for_function("currentView==='editor' && activeDrawingId==='s1'")
    assert page.locator('#sentlogSheetNav').count()==1
    assert page.locator('#sentlogSheetNav [data-role="select"] option').count()==2
    assert page.locator('#sentlogSheetNav [data-role="count"]').inner_text()=='1 / 2'
    assert page.locator('#editorDrawingAddBtn').inner_text()=='＋ この図面No.に追加'
    assert page.locator('label[for="fileInput"]').inner_text()=='このシートを差し替え'
    assert page.locator('#drawingNameView').inner_text()=='図面No.1 / 平面図'

    # Editor add opens the shared file picker but targets the current group.
    page.locator('#editorDrawingAddBtn').click()
    assert page.evaluate("addInputClicks")==1
    page.evaluate("promptValue='上流面'")
    page.evaluate("""async()=>{await createDrawingFromFile(new File(['x'],'upstream.pdf',{type:'application/pdf'}))}""")
    added=page.evaluate("workspace.projects[0].drawings.find(d=>d.id===activeDrawingId)")
    assert added['groupId']=='g1' and added['groupName']=='図面No.1' and added['sheetName']=='上流面' and added['sheetOrder']==3,added
    assert page.locator('#sentlogSheetNav [data-role="select"] option').count()==3
    assert page.locator('#sentlogSheetNav [data-role="count"]').inner_text()=='3 / 3'
    assert page.evaluate("persistCount>=2 && saveCount===1 && openFileCount===1")

    # Returning to the list keeps one card for No.1, now containing three sheets.
    page.evaluate("showDrawings('p1')")
    assert page.locator('.manager-card').count()==2
    assert '3シート' in page.locator('.manager-card[data-drawing-group-id="g1"] .drawing-group-sheets').inner_text()

    # List-level add clears group targeting and creates a brand-new drawing number.
    page.locator('#drawingsView label[for="drawingAddInput"]').click()
    page.evaluate("promptValue='図面No.3'")
    page.evaluate("""async()=>{await createDrawingFromFile(new File(['y'],'east.pdf',{type:'application/pdf'}))}""")
    newest=page.evaluate("workspace.projects[0].drawings.find(d=>d.id===activeDrawingId)")
    assert newest['groupId']==newest['id'] and newest['groupName']=='図面No.3' and newest['sheetName']=='east.pdf'.replace('.pdf',''),newest
    page.evaluate("showDrawings('p1')")
    assert page.locator('.manager-card').count()==3

    assert not errors,errors
    (ROOT/'test-results').mkdir(exist_ok=True)
    page.screenshot(path=str(ROOT/'test-results/drawing-groups-ui.png'),full_page=True)
    browser.close()
    print('PASS drawing groups UI: list cards are drawing numbers; editor add creates nested sheets; list add creates a new drawing number')

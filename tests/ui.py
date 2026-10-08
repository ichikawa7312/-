"""UI component checks with synthetic data. No live cloud calls or user data."""
import json, os
from pathlib import Path
from playwright.sync_api import sync_playwright
ROOT=Path(__file__).resolve().parents[1]
BASE='''<!doctype html><html lang="ja"><meta charset="UTF-8"><style>
body{margin:0;font:14px system-ui;background:#f3f4f6;color:#111827}header{padding:16px;background:#111827;color:white}.manager-shell{max-width:900px;margin:auto;padding:16px}.hidden{display:none!important}#projectsGrid{display:grid;grid-template-columns:repeat(auto-fit,minmax(230px,1fr));gap:12px}.manager-card{box-sizing:border-box;padding:18px;background:white;border:1px solid #d1d5db;border-radius:12px}.manager-card-title{font-size:18px;margin:12px 0}.manager-folder{font-size:30px}button{padding:10px;border:1px solid #cbd5e1;border-radius:8px;background:white;cursor:pointer}button:disabled{opacity:.45}#projectsEmpty{padding:10px}
</style><header>セントログ v1.34</header><section id="projectsView"><div class="manager-shell"><div id="projectsGrid"></div><p id="projectsEmpty"></p></div></section><section id="editorView"><div id="stageWrap"></div></section>
<script>
let currentView='projects',activeProjectId=null,tool='pan';
let workspace={projects:[{id:'a',name:'使用中の案件A',drawings:[]},{id:'b',name:'終了した案件B',drawings:[]}]};
function getProject(id=activeProjectId){return workspace.projects.find(p=>p.id===id);}
function renderProjects(){} function showDrawings(id){activeProjectId=id;currentView='drawings';} function showProjects(){activeProjectId=null;currentView='projects';renderProjects();}
async function getDBFile(){} function addShape(){} function addPhotosToSelected(){} function removeSelectedPhoto(){} function createDrawingFromFile(){} function savePageSettings(){} function resetPageSettings(){}
window.SentlogRecords={failed:false,pending:false,getItem:()=>null,settled:async()=>{},assertSafe(){}};
window.sentlogAppReady=Promise.resolve();window.sentlogCloudIdle=async()=>{};window.sentlogArchiveSync=async()=>{};
localStorage.setItem('sentlogCloudSessionV1',JSON.stringify({access_token:'synthetic-token',user:{id:'test-owner'}}));localStorage.setItem('sentlogCloudDeviceV1','device1');
</script></html>'''
with sync_playwright() as p:
    opts={'headless':True}
    if os.path.exists('/usr/bin/chromium'):opts.update(executable_path='/usr/bin/chromium',args=['--no-sandbox'])
    browser=p.chromium.launch(**opts)
    count=0
    for width in [320,390,768,1280]:
        page=browser.new_page(viewport={'width':width,'height':900})
        controls=[{'id':'ca','client_key':'a','name':'使用中の案件A','status':'active','checking':False}, {'id':'cb','client_key':'b','name':'終了した案件B','status':'archived','checking':False}]
        calls=[]
        def mock_fetch(url,body):
            if '/rest/v1/rpc/sentlog_archive_v1' in url:
                calls.append(body)
                if body['p_action']=='list':return {'status':200,'body':controls}
                return {'status':400,'body':{'message':'synthetic blocked request'}}
            if 'sentlog_project_snapshots?' in url:
                return {'status':200,'body':[{'revision':1,'payload':{'project':{'id':'a','name':'使用中の案件A','drawings':[]},'drawings':[]}}]}
            raise AssertionError('Unexpected network request '+url)
        page.expose_function('mockFetch',mock_fetch)
        page.evaluate("""() => {
          const data=new Map();Object.defineProperty(window,'localStorage',{value:{getItem:k=>data.get(k)??null,setItem:(k,v)=>data.set(k,String(v)),removeItem:k=>data.delete(k)}});
          window.fetch=async(url,opts={})=>{const r=await window.mockFetch(String(url),opts.body?JSON.parse(opts.body):null);return new Response(JSON.stringify(r.body),{status:r.status,headers:{'Content-Type':'application/json'}});};
        }""")
        page.set_content(BASE)
        page.add_script_tag(content=(ROOT/'sentlog/archive-core.js').read_text());page.add_script_tag(content=(ROOT/'sentlog/archive.js').read_text().replace('https://wiulvaqixphuobdielyy.supabase.co','http://127.0.0.1:8765'))
        page.evaluate('window.SentlogArchive.refresh()')
        assert page.get_by_role('button',name='📁 保管').count()==1
        assert page.locator('#projectsGrid').inner_text().find('使用中の案件A')>=0
        assert '終了した案件B' not in page.locator('#projectsGrid').inner_text()
        assert page.evaluate('document.documentElement.scrollWidth<=innerWidth')
        page.get_by_role('button',name='📁 保管').click()
        assert '終了した案件B' in page.locator('#projectsGrid').inner_text()
        assert '使用中の案件A' not in page.locator('#projectsGrid').inner_text()
        page.get_by_role('button',name='← 案件一覧へ').click()
        page.evaluate("workspace.projects[0].name='未同期の変更'")
        page.get_by_role('button',name='保管へ移す',exact=True).click()
        page.wait_for_function("document.getElementById('slArchiveMessage').textContent.includes('未同期')")
        assert not any(c['p_action']=='begin' for c in calls)
        assert page.evaluate('workspace.projects[0].name')=='未同期の変更'
        page.locator('#slArchiveClose').click()
        controls[0]['status']='archived';page.evaluate('window.SentlogArchive.refresh()')
        assert '未同期の変更' not in page.locator('#projectsGrid').inner_text()
        page.get_by_role('button',name='📁 保管').click()
        assert '未同期の変更' in page.locator('#projectsGrid').inner_text()
        assert len(page.evaluate('workspace.projects'))==2
        if width in (390,1280):
            (ROOT/'test-results').mkdir(exist_ok=True);page.screenshot(path=str(ROOT/f'test-results/archive-{width}.png'),full_page=True)
        page.close();count+=1;print(f'PASS UI {width}px: single archive folder, active-only list, no unsynced move, shared state, no data removal')
    browser.close();print(f'UI viewport scenarios passed: {count}')

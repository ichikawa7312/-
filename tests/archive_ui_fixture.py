from pathlib import Path
from playwright.sync_api import expect
ROOT=Path(__file__).resolve().parents[1]
BASE='''<!doctype html><html lang="ja"><meta charset="UTF-8"><style>
body{margin:0;font:14px system-ui;background:#f3f4f6;color:#111827}header{padding:16px;background:#111827;color:white}.manager-shell{max-width:900px;margin:auto;padding:16px}.hidden{display:none!important}#projectsGrid{display:grid;grid-template-columns:repeat(auto-fit,minmax(230px,1fr));gap:12px}.manager-card{box-sizing:border-box;padding:18px;background:white;border:1px solid #d1d5db;border-radius:12px}.manager-card-title{font-size:18px;margin:12px 0}.manager-folder{font-size:30px}button{padding:10px;border:1px solid #cbd5e1;border-radius:8px;background:white;cursor:pointer}button:disabled{opacity:.45}#projectsEmpty{padding:10px}
</style><header>セントログ</header><section id="projectsView"><div class="manager-shell"><div id="projectsGrid"></div><p id="projectsEmpty"></p></div></section><section id="editorView"><div id="stageWrap"></div></section>
<script>
let currentView='projects',activeProjectId=null,tool='pan';
let workspace={projects:[{id:'a',name:'試験用案件A',drawings:[]},{id:'b',name:'試験用案件B',drawings:[]}]};
function getProject(id=activeProjectId){return workspace.projects.find(p=>p.id===id);}
function renderProjects(){} function showDrawings(id){activeProjectId=id;currentView='drawings';} function showProjects(){activeProjectId=null;currentView='projects';renderProjects();}
async function getDBFile(){} function addShape(){} function addPhotosToSelected(){} function removeSelectedPhoto(){} function createDrawingFromFile(){} function savePageSettings(){} function resetPageSettings(){}
window.SentlogRecords={failed:false,pending:false,getItem:()=>null,settled:async()=>{},assertSafe(){}};
window.sentlogAppReady=Promise.resolve();window.sentlogCloudIdle=async()=>{};window.sentlogArchiveSync=async()=>{window.syncCalls++;};window.syncCalls=0;
localStorage.setItem('sentlogCloudSessionV1',JSON.stringify({access_token:'synthetic-token',user:{id:'test-owner'}}));localStorage.setItem('sentlogCloudDeviceV1','device1');
window.calls=[];window.testMode='success';
window.controls=[{id:'ca',client_key:'a',name:'試験用案件A',status:'active',checking:false},{id:'cb',client_key:'b',name:'試験用案件B',status:'active',checking:false}];
window.job={id:'job1',project_id:'ca',initiator:'device1',state:'checking',revision:1,catalog_hash:'test-hash',payload:JSON.parse(JSON.stringify({project:workspace.projects[0],drawings:[]})),manifest:[],required_devices:[{id:'device1',name:'この端末'},{id:'device2',name:'別の端末'}],reports:{},pc_receipt:null,expires_at:new Date(Date.now()+600000).toISOString()};
window.fetch=async(url,opts={})=>{
 const body=opts.body?JSON.parse(opts.body):null;calls.push({url,body});
 let result;
 if(String(url).includes('sentlog_archive_v1')){
   const act=body.p_action;
   if(window.failAction===act)return new Response(JSON.stringify({message:'試験用：通信エラー'}),{status:503});
   if(act==='list')result=controls;
   if(act==='begin'){controls[0].checking=true;controls[0].job_id=job.id;result=job;}
   if(act==='inspect')result=job;
   if(act==='report'){job.reports[body.p_device_id]={clean:body.p_data.clean,reason:body.p_data.reason,at:new Date().toISOString()};result={ok:true};}
   if(act==='cancel'){controls[0].checking=false;delete controls[0].job_id;job.state='cancelled';result={ok:true};}
   if(act==='finalize'){controls[0].checking=false;controls[0].status='archived';job.state='archived';result={ok:true};}
 }else if(String(url).includes('sentlog_project_snapshots?'))result=[{revision:1,payload:job.payload}];
 else throw Error('Unexpected network: '+url);
 if(result===undefined)throw Error('Unexpected action: '+JSON.stringify(body));
 return new Response(JSON.stringify(result),{status:200,headers:{'Content-Type':'application/json'}});
};
</script></html>'''

def make_page(browser,width=1280,source=None,init=''):
    page=browser.new_page(viewport={'width':width,'height':900})
    page.evaluate("""() => { const data=new Map();Object.defineProperty(window,'localStorage',{value:{getItem:k=>data.get(k)??null,setItem:(k,v)=>data.set(k,String(v)),removeItem:k=>data.delete(k)}}); }""")
    page.set_content(BASE)
    if init:page.evaluate('() => {'+init+'}')
    page.add_script_tag(content=(ROOT/'sentlog/archive-core.js').read_text())
    page.add_script_tag(content=source or (ROOT/'sentlog/archive.js').read_text())
    page.evaluate('window.SentlogArchive.refresh()')
    return page

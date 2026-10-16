"""Browser check for device-local originals. Synthetic data only; no cloud calls."""
import os
from pathlib import Path
from playwright.sync_api import sync_playwright

ROOT=Path(__file__).resolve().parents[1]
BASE='''<!doctype html><html lang="ja"><meta charset="UTF-8"><body>
<div id="photoStatus"></div>
<div id="sentlogSettingsModal"><div class="modal-card"><details id="sentlogStorageSection"></details><details id="sentlogBackupSection"></details></div></div>
<script>
let activeDrawingId='drawing-1',activeProjectId='project-1',selected='shape-1';
let workspace={projects:[{id:'project-1',name:'依田川農水頭首工',drawings:[{id:'drawing-1',name:'下流面'}]}]};
let state={project:'依田川農水頭首工',shapes:[{id:'shape-1',type:'ひび割れ',typeNo:12,autoLabel:'ひび割れ-12',photos:[]}]};
let sharedBlob=null,persistCount=0,historyCount=0;
function selectedShape(){return state.shapes.find(x=>x.id===selected)||null}
function getProject(){return workspace.projects[0]}
function getDrawingMeta(){return workspace.projects[0].drawings[0]}
function uid(){return 'photo-'+(state.shapes[0].photos.length+1)}
function pushHistory(){historyCount++}
function persist(){persistCount++}
async function savePhotoBlob(id,blob,drawingId){sharedBlob=blob}
async function renderSelectedPhotos(){}
</script></body></html>'''

with sync_playwright() as p:
    opts={'headless':True}
    if os.path.exists('/usr/bin/chromium'):
        opts.update(executable_path='/usr/bin/chromium',args=['--no-sandbox'])
    browser=p.chromium.launch(**opts)
    page=browser.new_page(viewport={'width':390,'height':844})
    errors=[]
    page.on('pageerror',lambda e: errors.append(str(e)))
    page.set_content(BASE)
    page.add_script_tag(content=(ROOT/'sentlog/original-photo-store.js').read_text(encoding='utf-8'))
    page.wait_for_selector('#sentlogOriginalPhotosSection')
    result=page.evaluate('''async()=>{
      const c=document.createElement('canvas');c.width=2400;c.height=1800;const x=c.getContext('2d');
      const g=x.createLinearGradient(0,0,2400,1800);g.addColorStop(0,'#101010');g.addColorStop(.5,'#d4d4d4');g.addColorStop(1,'#4040ff');x.fillStyle=g;x.fillRect(0,0,c.width,c.height);
      x.fillStyle='white';x.font='120px sans-serif';x.fillText('SHINWA 0.20mm',100,500);
      const source=await new Promise(r=>c.toBlob(r,'image/jpeg',.96));
      const file=new File([source],'IMG_1234.JPG',{type:'image/jpeg',lastModified:Date.UTC(2026,9,17,1,2,3)});
      const exactBytes=async(a,b)=>{const aa=new Uint8Array(await a.arrayBuffer()),bb=new Uint8Array(await b.arrayBuffer());if(aa.length!==bb.length)return false;for(let i=0;i<aa.length;i++)if(aa[i]!==bb[i])return false;return true;};
      await addPhotosToSelected([file]);
      const photo=state.shapes[0].photos[0],original=await SentlogOriginalPhotos.getOriginal('drawing-1',photo.id),meta=(await SentlogOriginalPhotos.listMeta())[0],stats=await SentlogOriginalPhotos.stats();
      const shared=sharedBlob;
      const sharedSize=await new Promise((resolve,reject)=>{const u=URL.createObjectURL(shared),im=new Image();im.onload=()=>{resolve([im.naturalWidth,im.naturalHeight]);URL.revokeObjectURL(u)};im.onerror=reject;im.src=u});
      const beforeCleanup=await SentlogOriginalPhotos.deleteExported();
      const stillThere=!!(await SentlogOriginalPhotos.getOriginal('drawing-1',photo.id));
      await SentlogOriginalPhotos.markExported([meta.key],'test.zip');
      const cleanup=await SentlogOriginalPhotos.deleteExported();
      const removed=!(await SentlogOriginalPhotos.getOriginal('drawing-1',photo.id));
      return {sourceSize:file.size,originalSize:original.size,exactOriginal:await exactBytes(file,original),sharedSize:shared.size,sharedDims:sharedSize,
        photo,meta,stats,beforeCleanup,stillThere,cleanup,removed,persistCount,historyCount,
        ui:document.getElementById('sentlogOriginalPhotosSection').innerText};
    }''')
    assert result['sourceSize']==result['originalSize'] and result['exactOriginal'],result
    assert max(result['sharedDims'])==1600 and result['sharedSize']<result['sourceSize'],result
    assert result['stats']['count']==1 and result['stats']['unexportedCount']==1,result
    assert result['meta']['projectName']=='依田川農水頭首工' and result['meta']['drawingName']=='下流面' and result['meta']['shapeLabel']=='ひび割れ-12',result
    assert result['beforeCleanup']['count']==0 and result['stillThere'],result
    assert result['cleanup']['count']==1 and result['removed'],result
    assert result['persistCount']==1 and result['historyCount']==1,result
    assert '会社PCと同じ' in result['ui'] and '未書き出し原本' in result['ui'],result
    assert not errors,errors
    (ROOT/'test-results').mkdir(exist_ok=True);page.screenshot(path=str(ROOT/'test-results/original-photo-ui.png'),full_page=True)
    browser.close()
    print('PASS original photo UI: exact source kept locally, 1600px shared JPEG, unexported cleanup blocked, PC-layout export UI')

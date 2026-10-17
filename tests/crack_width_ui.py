"""Browser check for the v1.63 concrete crack-width wheel. Synthetic records only."""
import os
from pathlib import Path
from playwright.sync_api import sync_playwright

ROOT=Path(__file__).resolve().parents[1]
BASE='''<!doctype html><html lang="ja"><meta charset="UTF-8"><style>
body{font:14px system-ui;margin:20px}.stack{width:320px}.stack>div{margin:8px 0}button,select,input{font:inherit}svg{border:1px solid #ddd;width:600px;height:300px}
</style><body>
<div class="stack">
  <div><label>材料・対象</label><select id="damageMaterial"><option value="all">すべて</option><option value="concrete">コンクリート</option><option value="steel">鋼材</option></select></div>
  <div><label>損傷種類</label><select id="damageType"><option>ひび割れ</option><option>床版ひび割れ</option><option>亀裂</option><option>腐食</option></select></div>
  <div><label>部材</label><input id="member"></div>
</div>
<svg id="svg" xmlns="http://www.w3.org/2000/svg"></svg>
<script>
let selected='c1',activeProjectId='p1',activeDrawingId='d1',currentView='editor',scale=1,historyCount=0,persistCount=0,nextId=1;
let state={currentPage:1,shapes:[
 {id:'c1',page:1,type:'ひび割れ',autoLabel:'ひび割れ-1',labelPos:{x:150,y:80}},
 {id:'s1',page:1,type:'亀裂',autoLabel:'亀裂-1',labelPos:{x:350,y:80}}
]};
const svg=document.getElementById('svg');
function getProject(){return {id:'p1',name:'試験案件'}}
function currentShapes(){return state.shapes.filter(s=>(s.page||1)===state.currentPage)}
function getLabelPos(s){return s.labelPos||{x:100,y:100}}
function labelFontSize(){return 18}
function makeEl(tag,attrs){const e=document.createElementNS('http://www.w3.org/2000/svg',tag);for(const [k,v] of Object.entries(attrs||{}))e.setAttribute(k,v);return e}
function pushHistory(){historyCount++}
function persist(){persistCount++}
function render(){svg.innerHTML='';for(const s of currentShapes()){const p=getLabelPos(s),t=makeEl('text',{x:p.x,y:p.y});t.textContent=s.autoLabel;svg.appendChild(t)}}
function selectShape(id){selected=id;const s=state.shapes.find(x=>x.id===id);if(s)document.getElementById('damageType').value=s.type;render()}
function addShape(s){s.id='n'+nextId++;s.page=1;s.type=document.getElementById('damageType').value;s.autoLabel=s.type+'-'+nextId;s.labelPos={x:250,y:180};state.shapes.push(s);selected=s.id;selectShape(s.id);persist()}
window.SentlogDamageCatalog={
 forProject(){return [
  {name:'ひび割れ',group:'concrete'},{name:'床版ひび割れ',group:'concrete'},
  {name:'亀裂',group:'steel'},{name:'腐食',group:'steel'}
 ]},
 matchName(list,name){return list.find(x=>x.name===name)||null}
};
window.SentlogDamageStyles={getMode(){return 'hatch'}};
window.SentlogLabelColors={labelStyle(){return {color:'#C62828',halo:2.2}}};
render();
</script></body></html>'''

with sync_playwright() as p:
    opts={'headless':True}
    if os.path.exists('/usr/bin/chromium'):
        opts.update(executable_path='/usr/bin/chromium',args=['--no-sandbox'])
    browser=p.chromium.launch(**opts)
    page=browser.new_page(viewport={'width':390,'height':844})
    errors=[]
    page.on('pageerror',lambda e: errors.append(str(e)))
    page.route('https://sentlog.test/',lambda route: route.fulfill(status=200,content_type='text/html',body=BASE))
    page.goto('https://sentlog.test/')
    page.add_script_tag(content=(ROOT/'sentlog/crack-width.js').read_text(encoding='utf-8'))
    page.evaluate("selectShape('c1')")
    assert page.locator('#crackWidthField').is_visible()
    assert page.locator('#crackWidthOpen').inner_text()=='未測定'

    page.locator('#crackWidthOpen').click()
    assert page.locator('#crackWidthModal').evaluate("e=>e.classList.contains('open')")
    assert page.locator('#crackWidthWheel button').count()==200
    page.evaluate("""()=>{
      const w=document.getElementById('crackWidthWheel');
      w.scrollTop=3*44;w.dispatchEvent(new Event('scroll'));
    }""")
    page.wait_for_timeout(60)
    assert page.locator('#crackWidthValue').inner_text()=='W=0.2'
    page.locator('#crackWidthSave').click()
    result=page.evaluate("""()=>({
      width:state.shapes.find(x=>x.id==='c1').crackWidthMm,
      labels:[...svg.querySelectorAll('text')].map(x=>x.textContent),
      button:document.getElementById('crackWidthOpen').textContent,
      history:historyCount,persist:persistCount
    })""")
    assert result['width']==0.2,result
    assert 'W=0.2' in result['labels'],result
    assert result['button']=='0.2 mm',result
    assert result['history']==1 and result['persist']>=1,result

    page.evaluate("selectShape('s1')")
    assert page.locator('#crackWidthField').is_hidden()

    page.evaluate("""()=>{
      document.getElementById('damageType').value='ひび割れ';
      addShape({kind:'line',points:[{x:10,y:10},{x:30,y:30}]});
    }""")
    page.wait_for_function("document.getElementById('crackWidthModal').classList.contains('open')")
    assert page.locator('#crackWidthValue').inner_text()=='W=0.2'
    new_shape=page.evaluate("state.shapes.at(-1)")
    assert new_shape['type']=='ひび割れ' and 'crackWidthMm' not in new_shape,new_shape

    assert not errors,errors
    (ROOT/'test-results').mkdir(exist_ok=True)
    page.screenshot(path=str(ROOT/'test-results/crack-width-ui.png'),full_page=True)
    browser.close()
    print('PASS crack width UI: concrete crack only, 0.05mm wheel, W=0.2 second line, previous value reused, auto-open after drawing')

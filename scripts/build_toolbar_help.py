"""v1.52: finger-safe help placement, after build_toolbar_icons.py.
Guarded static changes only. No user records, cloud data or permissions changed.
"""
from pathlib import Path
ROOT=Path(__file__).resolve().parents[1]
def change(path,old,new,count=1):
 p=ROOT/path;s=p.read_text()
 if s.count(old)!=count:raise RuntimeError(f'Tool help integration mismatch {path}: {old[:70]!r}, {s.count(old)} != {count}')
 p.write_text(s.replace(old,new))
p='sentlog/toolbar-icons.js'
change(p,'/* Sentlog v1.51:','/* Sentlog v1.52:')
change(p,"bar.dataset.iconToolbar='151'","bar.dataset.iconToolbar='152'")
change(p,"version:'v1.51'","version:'v1.52'")
change(p,'#sentlogToolTip{position:fixed;', '#sentlogToolTip{box-sizing:border-box;overflow:auto;overscroll-behavior:contain;position:fixed;')
change(p,'#sentlogToolTip[hidden]{', '#sentlogToolTip[data-input="hold"]{padding:6px 10px;line-height:1.35}\n  #sentlogToolTip[hidden]{')
change(p,'  const pointers=new Set();', '''  const pointers=new Set(),dismissPointers=new Set();
  let dismissClickUntil=0;
  const swallow=e=>{e.preventDefault();e.stopImmediatePropagation();};
  // BEGIN TOOLTIP POSITION: pure geometry, tested independently of the DOM.
  function tooltipPosition(r,size,v,kind){
    const gap=8,L=v.left+gap,T=v.top+gap,R=v.left+v.width-gap,B=v.top+v.height-gap;
    const w=Math.min(size.width,R-L),h=Math.min(size.height,B-T);
    if(w<=0||h<=0)return null;
    const clamp=(n,a,b)=>Math.max(a,Math.min(n,b));
    const x=clamp((r.left+r.right-w)/2,L,R-w),y=clamp((r.top+r.bottom-h)/2,T,B-h);
    const above={left:x,top:r.top-gap-h,width:w,height:h,placement:'above'};
    const below={left:x,top:r.bottom+(kind==='hold'?40:gap),width:w,height:h,placement:'below'};
    const sides=[{left:r.right+gap,top:y,width:w,height:h,placement:'right'},
                 {left:r.left-gap-w,top:y,width:w,height:h,placement:'left'}];
    const candidates=kind==='hold'?[above,...sides,below,{...below,top:r.bottom+gap}]:[below,above,...sides];
    for(const c of candidates){
      if(c.left>=L&&c.top>=T&&c.left+c.width<=R+.01&&c.top+c.height<=B+.01)return c;
    }
    // Unusually short/zoomed view: scroll within free space, never over the button.
    const up=Math.max(0,Math.min(B,r.top-gap)-T),down=Math.max(0,B-Math.max(T,r.bottom+gap));
    if(!up&&!down)return null;
    const upper=up>=down,limit=Math.min(h,upper?up:down);
    return {left:x,top:upper?Math.min(B,r.top-gap)-limit:Math.max(T,r.bottom+gap),
      width:w,height:limit,placement:upper?'above':'below'};
  }
  // END TOOLTIP POSITION
''')
old='''    if(b.disabled)tip.append(make('div','現在は実行できません。'));tip.hidden=false;tipOwner=b;tipKind=kind;
    const r=b.getBoundingClientRect(),v=window.visualViewport,left=v?.offsetLeft||0,top=v?.offsetTop||0,vw=v?.width||innerWidth,vh=v?.height||innerHeight;
    const t=tip.getBoundingClientRect();tip.style.left=Math.max(left+8,Math.min(r.x+r.width/2-t.width/2,left+vw-t.width-8))+'px';
    tip.style.top=Math.max(top+8,Math.min(bar.getBoundingClientRect().bottom+5,top+vh-t.height-8))+'px';'''
new='''    if(b.disabled)tip.append(make('div','現在は実行できません。'));tip.hidden=false;tipOwner=b;tipKind=kind;tip.dataset.input=kind;
    const r=b.getBoundingClientRect(),v=window.visualViewport;
    const viewport={left:v?.offsetLeft||0,top:v?.offsetTop||0,width:v?.width||innerWidth,height:v?.height||innerHeight};
    // Reset the old position before measuring; old right-edge placement must not wrap text differently.
    tip.style.left='0px';tip.style.top='0px';tip.style.maxHeight=Math.max(1,viewport.height-16)+'px';
    tip.style.maxWidth=Math.max(1,viewport.width-16)+'px';
    tip.style.width=Math.max(1,Math.min(kind==='hold'?360:306,viewport.width-16))+'px';
    const pos=tooltipPosition(r,tip.getBoundingClientRect(),viewport,kind);
    if(!pos){hide();return;}
    tip.dataset.placement=pos.placement;
    tip.style.left=pos.left+'px';tip.style.top=pos.top+'px';tip.style.maxHeight=pos.height+'px';'''
change(p,old,new)
change(p,"  document.addEventListener('pointerdown',e=>{\n    keyboard=false;", """  document.addEventListener('pointerdown',e=>{
    // Tapping the drawing/header to dismiss held help must not draw, drag or navigate.
    // Toolbar buttons remain deliberate commands, including immediately after a hold.
    if(dismissPointers.size||(!tip.hidden&&tipKind==='hold'&&!bar.contains(e.target)&&!tip.contains(e.target))){
      dismissPointers.add(e.pointerId);dismissClickUntil=performance.now()+2000;
      pointers.delete(e.pointerId);cancel();hide();swallow(e);return;
    }
    dismissClickUntil=0;
    keyboard=false;""")
change(p,"  document.addEventListener('pointermove',e=>{\n", "  document.addEventListener('pointermove',e=>{\n    if(dismissPointers.has(e.pointerId)){swallow(e);return;}\n")
change(p,"  document.addEventListener('pointerup',e=>{\n", "  document.addEventListener('pointerup',e=>{\n    if(dismissPointers.delete(e.pointerId)){dismissClickUntil=performance.now()+2000;swallow(e);return;}\n")
change(p,"document.addEventListener('pointercancel',e=>{pointers.delete(e.pointerId);", "document.addEventListener('pointercancel',e=>{if(dismissPointers.delete(e.pointerId)){swallow(e);return;}pointers.delete(e.pointerId);")
change(p,"  tip.addEventListener('pointerenter',", """  document.addEventListener('click',e=>{if(performance.now()<dismissClickUntil){dismissClickUntil=0;swallow(e);}},true);
  tip.addEventListener('pointerenter',""")
change(p,"keyboard=true;suppressed.clear();", "keyboard=true;suppressed.clear();dismissClickUntil=0;")
change(p,"pointers.clear();cancel();hide();", "pointers.clear();dismissPointers.clear();cancel();hide();",2)
change(p,"window.visualViewport?.addEventListener('resize',resized);", "window.visualViewport?.addEventListener('resize',resized);window.visualViewport?.addEventListener('scroll',()=>{cancel();hide();});")
p='sentlog/index.html'
change(p,'toolbar-icons.js?v=151','toolbar-icons.js?v=152',2)
change(p,"'v1.51'","'v1.52'")
change(p,'phone-runtime.js?v=151','phone-runtime.js?v=152',2)
change('sentlog/phone-runtime.js','v1.51','v1.52',4)
change('sentlog/sw.js',"const CACHE='sentlog-pwa-v162';","const CACHE='sentlog-pwa-v163';")
for name in ('full_management.py','full_archive_click.py','capacity_ui.py','shape_move_ui.py','instant_damage_type_ui.py','overview_labels_ui.py','polygon_snap_ui.py','polygon_dimensions_ui.py','toolbar_icons_ui.py'):
 change('tests/'+name,"window.SENTLOG_BUILD==='v1.51'","window.SENTLOG_BUILD==='v1.52'")
change('tests/damage_catalog_ui.py',"window.SENTLOG_BUILD==='v1.51'","window.SENTLOG_BUILD==='v1.52'",2)
for name in ('capacity.test.cjs','resilience.test.cjs','toolbar_icons.test.cjs'):
 change('tests/'+name,"'v1.51'","'v1.52'")
change('tests/toolbar_icons.test.cjs','toolbar-icons.js?v=151','toolbar-icons.js?v=152',2)
change('tests/toolbar_icons.test.cjs','sentlog-pwa-v162','sentlog-pwa-v163')
print('Built Sentlog v1.52: hold help above fingers, bounded fallback, read-after-release and safe outside dismissal')

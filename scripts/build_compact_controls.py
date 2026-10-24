"""Sentlog v2.00: compact page/record controls without changing behavior."""
from pathlib import Path
import subprocess

ROOT=Path(__file__).resolve().parents[1]

def change(path,old,new,count=1):
    p=ROOT/path;s=p.read_text()
    n=s.count(old)
    if n!=count:
        raise RuntimeError(f'compact controls integration mismatch {path}: {old[:80]!r}: {n}')
    p.write_text(s.replace(old,new))

# Distinguish whole-drawing replacement from single-page replacement and shorten destructive controls.
change('sentlog/part03.txt','<label class="btn" for="fileInput">この図面を差し替え</label>','<label class="btn sentlog-whole-replace" for="fileInput" title="PDF／図面全体を差し替えます">図面全体差替</label>')
change('sentlog/part03.txt','>↶ 左90°</button>','>↺90°</button>')
change('sentlog/part03.txt','>右90° ↷</button>','>↻90°</button>')
change('sentlog/part03.txt','<button id="clearBtn">このページの描画を全削除</button>','<button id="clearBtn" title="現在ページの描画をすべて削除">ページ描画を全削除</button>')
change('sentlog/part04.txt','<button id="deleteBtn" disabled>選択変状を削除</button>','<button id="deleteBtn" disabled title="選択中の記録を削除">削除</button>')

# Compact page-operation labels; retain detail in title/aria text.
p=ROOT/'sentlog/page-management.js';s=p.read_text()
change_text="if(manage)manage.textContent='ページ管理'+((state?.pageStates&&Object.values(state.pageStates).some(x=>x?.hidden))?'（非表示あり）':'');"
replacement="if(manage){const hasHidden=!!(state?.pageStates&&Object.values(state.pageStates).some(x=>x?.hidden));manage.textContent='管理';manage.title=hasHidden?'ページ管理（非表示あり）':'ページ管理';manage.setAttribute('aria-label',manage.title);}"
if s.count(change_text)!=1: raise RuntimeError('compact manager dynamic label mismatch')
s=s.replace(change_text,replacement)
s=s.replace("manage.textContent='ページ管理';manage.onclick=openManager;","manage.textContent='管理';manage.title='ページ管理';manage.setAttribute('aria-label','ページ管理');manage.onclick=openManager;",1)
s=s.replace("hide.textContent='このページを削除';hide.className='sentlog-page-hide-current';","hide.textContent='非表示';hide.title='現在ページを非表示（記録は削除しません）';hide.setAttribute('aria-label',hide.title);hide.className='sentlog-page-hide-current';",1)
old_style=".sentlog-page-actions{display:none;grid-template-columns:1fr 1fr;gap:8px}.sentlog-page-actions button{min-height:40px}"
new_style=".sentlog-page-actions{display:none;grid-template-columns:repeat(2,minmax(0,1fr));gap:6px}.sentlog-page-actions button{min-height:38px;padding:6px 4px;font-size:11.5px;white-space:normal;line-height:1.15}"
if s.count(old_style)!=1: raise RuntimeError('compact manager style mismatch')
s=s.replace(old_style,new_style)
# Keep two columns on narrow phones now that labels are compact.
s=s.replace(".sentlog-page-actions{grid-template-columns:1fr}.sentlog-page-actions button{min-height:44px}",".sentlog-page-actions{grid-template-columns:repeat(2,minmax(0,1fr))}.sentlog-page-actions button{min-height:40px}",1)
p.write_text(s)

p=ROOT/'sentlog/page-replacement.js';s=p.read_text()
s=s.replace("replace.textContent='このページを差し替え';","replace.textContent='差し替え';replace.title='現在ページだけを差し替え';replace.setAttribute('aria-label',replace.title);",1)
s=s.replace("undo.textContent='直前の差し替えを元に戻す';","undo.textContent='差替を戻す';undo.title='直前のページ差し替えを元に戻す';undo.setAttribute('aria-label',undo.title);",1)
# Add role colors and merge the original rotation buttons into the same compact 2-column control grid.
old="style.textContent='#sentlogPageReplaceBtn{border-color:#93c5fd;background:#eff6ff;color:#1d4ed8}#sentlogPageReplaceUndoBtn{border-color:#d1d5db;background:#fff;color:#374151}#sentlogPageReplaceUndoBtn:disabled{opacity:.45}';"
new="style.textContent='#sentlogPageReplaceBtn{border-color:#93c5fd;background:#eff6ff;color:#1d4ed8}#sentlogPageReplaceUndoBtn,#sentlogPageManageBtn,#rotateLeftBtn,#rotateRightBtn{border-color:#d1d5db;background:#fff;color:#374151}#sentlogPageHideBtn{border-color:#fecaca;background:#fff7f7;color:#b91c1c}#sentlogPageReplaceUndoBtn:disabled{opacity:.45}#sentlogPageManagementActions #rotationControls{display:contents!important}';"
if s.count(old)!=1: raise RuntimeError('compact replacement style mismatch')
s=s.replace(old,new)
needle="host.append(replace,undo);document.body.append(input);"
repl="host.append(replace,undo);const rotations=byId('rotationControls');if(rotations)host.append(rotations);document.body.append(input);"
if s.count(needle)!=1: raise RuntimeError('compact rotation placement mismatch')
s=s.replace(needle,repl)
p.write_text(s)

p=ROOT/'sentlog/record-transfer.js';s=p.read_text()
s=s.replace("const btn=button('記録をコピー／移動',open);","const btn=button('コピー／移動',open);btn.title='記録を別図面／別ページへコピーまたは移動';btn.setAttribute('aria-label',btn.title);",1)
p.write_text(s)

# Focused regression checks for the exact UI contract.
subprocess.run(['node','--check','sentlog/page-management.js'],cwd=ROOT,check=True)
subprocess.run(['node','--check','sentlog/page-replacement.js'],cwd=ROOT,check=True)
subprocess.run(['node','--check','sentlog/record-transfer.js'],cwd=ROOT,check=True)
subprocess.run(['node','tests/compact_controls.test.cjs'],cwd=ROOT,check=True)
print('Built Sentlog v2.00: compact 2-column page controls and shortened record actions')

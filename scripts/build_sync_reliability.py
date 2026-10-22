"""v1.89 after the v1.88 build: session serialization and truthful PC progress.
Static-code transformations only; no production database or user-file mutations.
"""
from pathlib import Path
import re, subprocess
ROOT=Path(__file__).resolve().parents[1]
def change(path, old, new, count=1):
 p=ROOT/path;s=p.read_text()
 if s.count(old)!=count:raise RuntimeError(f'Sync reliability integration mismatch: {path}: {old[:90]!r}: {s.count(old)}')
 p.write_text(s.replace(old,new))
def section(path, start, end, replacement):
 p=ROOT/path;s=p.read_text()
 if s.count(start)!=1 or s.count(end)!=1:raise RuntimeError(f'Unknown sync section: {path}: {start}')
 a=s.index(start);b=s.index(end,a)
 p.write_text(s[:a]+replacement+'\n'+s[b:])

p='sentlog/cloud-sync.js'
section(p,'function loadSession(){','// Retry only reads. A failed write',"""let authNeedsLogin=false;
const sessionGuard=window.SentlogSessionGuard.create({baseUrl:SUPABASE_URL,apiKey:SUPABASE_KEY,key:SESSION_KEY,onChange:(s,required)=>{session=s;authNeedsLogin=required;updateCloudUI();}});
function loadSession(){session=sessionGuard.read();authNeedsLogin=sessionGuard.required();}
function saveSession(s){return sessionGuard.set(s);}
async function refreshSession(){session=await sessionGuard.ensure();return session;}
async function ensureSession(){session=await sessionGuard.ensure();return session;}
""")
change(p,"  syncStatus.setAccount(session?.user?.id||'');\n  syncStatus.setOnline(navigator.onLine);", "  syncStatus.setAccount(session?.user?.id||'');\n  syncStatus.setAuthRequired(authNeedsLogin);\n  syncStatus.setOnline(navigator.onLine);")
# A permanent auth failure retains a visible red re-login label even after focus/offline events.
p='sentlog/sync-status.js'
change(p,"  let account = '', online = true, cycle = 0, running = false;", "  let authRequired=false;\n  let account = '', online = true, cycle = 0, running = false;")
change(p,"    if(account) {", "    if(authRequired) {title='再ログイン';kind='err';}\n    else if(account) {")
change(p,"kind === 'err' ? '要確認'", "authRequired ? '再ログイン' : kind === 'err' ? '要確認'")
change(p,"    text(detailResult, outcome.message || '');", "    text(detailResult, authRequired ? window.SentlogSessionGuard.message : (outcome.message || ''));")
change(p,"    attr(detailResult, 'data-level', outcome.level);", "    attr(detailResult, 'data-level', authRequired ? 'error' : outcome.level);")
change(p,"  return {mount,setAccount,setOnline,begin,track,finish,refresh:render};", "  function setAuthRequired(value){authRequired=!!value;render();}\n  return {mount,setAccount,setOnline,setAuthRequired,begin,track,finish,refresh:render};")
p='sentlog/cloud-sync.js'
s=(ROOT/p).read_text();s,n=re.subn(r"sync-status\.js\?v=\d+",'sync-status.js?v=189',s)
if n!=1:raise RuntimeError('Unknown sync-status import')
(ROOT/p).write_text(s)

p='sentlog-pc/index.html'
change(p,'<script>\nconst SUPABASE_URL=', '<script src="../sentlog/session-guard.js?v=189"></script>\n<script>\nconst SUPABASE_URL=')
section(p,'function loadSession(){','async function rest(path,opt={}){',"""const sessionGuard=window.SentlogSessionGuard.create({baseUrl:SUPABASE_URL,apiKey:API_KEY,key:SESSION_KEY,onChange:(s,required)=>{session=s;if(!s&&timer){clearInterval(timer);timer=null;}refreshUI();if(required)setSync(window.SentlogSessionGuard.message,'err');}});
function loadSession(){
 session=sessionGuard.read();
 if(!session&&!sessionGuard.required()){try{const legacy=JSON.parse(localStorage.getItem(LEGACY_SESSION_KEY)||'null');if(legacy)sessionGuard.set(legacy);}catch{}}
 localStorage.removeItem(LEGACY_SESSION_KEY);session=sessionGuard.read();
 if(sessionGuard.required())setSync(window.SentlogSessionGuard.message,'err');
}
function saveSession(s){localStorage.removeItem(LEGACY_SESSION_KEY);return sessionGuard.set(s);}
async function refreshSession(){session=await sessionGuard.ensure();return session;}
async function ensureSession(){session=await sessionGuard.ensure();return session;}
""")
runtime=(ROOT/'sentlog/pc-sync-progress.txt').read_text()
cut=runtime.index('async function syncOnce(){')
section(p,'async function pendingAssets(){','async function downloadAsset(a){',runtime[:cut])
section(p,'async function syncOnce(){','function start(){',runtime[cut:])
# Retain byte-size + SHA-256 verification. Download only if the selected PC file differs.
change(p,'  const blob=await downloadAsset(a);\n  const project=', '  const project=')
change(p,'if(!ok){const w=await fh.createWritable();await w.write(blob);', 'if(!ok){const blob=await downloadAsset(a);const w=await fh.createWritable();await w.write(blob);')
change(p,'<b id="pendingCount">0</b><small>クラウド待機</small>', '<b id="pendingCount">—</b><small>クラウドに残っている件数</small>')
change(p,'<small>今回PC保存</small>', '<small>今回PC保存・再照合</small>')
change(p,'  <div class="card">\n    <h2>動作ログ</h2>', '  <div class="card">\n    <p id="pendingDetail" class="muted">内訳は同期開始時に確認します。</p>\n    <p id="pendingTime" class="muted"></p>\n    <p class="muted">クラウドの残件には、PC保存済みで別端末への配信・整理を待っているデータも含みます。PC未保存件数とは異なります。</p>\n    <h2>動作ログ</h2>')
change(p,'v1.86 · 写真再取得の全件確認','v1.89 · 同期状況の内訳・認証復旧')

p='sentlog/index.html'
change(p,"const deps=[", "const deps=[['session-guard.js?v=189','SentlogSessionGuard'],")
change(p,"let html=parts.join('');", "let html=parts.join('');html=html.replace('</head>','<script src=\"./session-guard.js?v=189\"><\\/script></head>');")
change(p,'cloud-sync.js?v=20261020-review-186','cloud-sync.js?v=20261022-auth-189',2)
change(p,'phone-runtime.js?v=188','phone-runtime.js?v=189',2)
change(p,"['phone-runtime.js?v=189','v1.88']", "['phone-runtime.js?v=189','v1.89']")
change('sentlog/phone-runtime.js','v1.88','v1.89',4)
change('sentlog/sw.js','sentlog-pwa-v199','sentlog-pwa-v200')
change('sentlog/sw.js',"'sync-status.js'","'sync-status.js','session-guard.js'")
for p in (ROOT/'tests').iterdir():
 if p.suffix not in ('.py','.cjs'):continue
 s=p.read_text();u=s.replace("'v1.88'","'v1.89'").replace('phone-runtime.js?v=188','phone-runtime.js?v=189').replace(r'phone-runtime\.js\?v=188',r'phone-runtime\.js\?v=189').replace('sentlog-pwa-v199','sentlog-pwa-v200').replace('cloud-sync.js?v=20261020-review-186','cloud-sync.js?v=20261022-auth-189').replace(r'cloud-sync\.js\?v=20261020-review-186',r'cloud-sync\.js\?v=20261022-auth-189')
 if u!=s:p.write_text(u)
subprocess.run(['node','tests/session_guard.test.cjs'],cwd=ROOT,check=True)
subprocess.run(['node','tests/pc_sync_progress.test.cjs'],cwd=ROOT,check=True)
print('Built v1.89: serialized auth refresh, explicit re-login, live PC progress; no user data reset')

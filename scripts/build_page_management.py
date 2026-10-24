"""Sentlog v1.92: reversible per-page visibility for multi-page PDFs.

Runs after the existing v1.91 build chain. Source PDFs and cloud assets are never
rewritten; only drawing snapshot metadata changes.
"""
from pathlib import Path
import subprocess

ROOT=Path(__file__).resolve().parents[1]

def change(path,old,new,count=1):
    p=ROOT/path;s=p.read_text()
    if s.count(old)!=count:
        raise RuntimeError(f'Page-management integration mismatch: {path}: {old[:100]!r}: {s.count(old)}')
    p.write_text(s.replace(old,new))

# Main loader: verify and load the page manager after the editor exists.
p='sentlog/index.html'
change(p,
       "['drawing-export.js?v=191','SentlogDrawingExport v1.91']",
       "['drawing-export.js?v=191','SentlogDrawingExport v1.91'],['page-management.js?v=192','SentlogPageManagement v1.92']")
change(p,
       '<script src="./drawing-export.js?v=191"><\\/script>',
       '<script src="./drawing-export.js?v=191"><\\/script><script src="./page-management.js?v=192"><\\/script>')
change(p,'phone-runtime.js?v=191','phone-runtime.js?v=192',2)
change(p,"['phone-runtime.js?v=192','v1.91']","['phone-runtime.js?v=192','v1.92']")
change('sentlog/phone-runtime.js','v1.91','v1.92',4)
change('sentlog-pc/index.html','v1.91','v1.92',1)

# Offline app shell: page-management is static code only.
change('sentlog/sw.js','sentlog-pwa-v202','sentlog-pwa-v203')
change('sentlog/sw.js',"'session-guard.js','sync-traffic.js'","'session-guard.js','sync-traffic.js','page-management.js'")

# Merge page visibility per original PDF page. Different-page offline edits merge.
# On a true same-page tie, visible wins so an old device cannot unexpectedly hide work.
p='sentlog/sync-merge.js'
old="""    const clash=(path,reason='内容が異なります')=>{conflicts.push({path,reason});return undefined;};"""
new=old+"""
    function pageEntry(value){
      const v=object(value)?value:{};
      const revision=Number.isSafeInteger(Number(v.revision))&&Number(v.revision)>=0?Number(v.revision):0;
      const updatedAt=Number.isFinite(Number(v.updatedAt))&&Number(v.updatedAt)>=0?Number(v.updatedAt):0;
      return {hidden:v.hidden===true,revision,updatedAt};
    }
    function mergePageStates(l,r,b,path){
      const out={},keys=new Set([...Object.keys(object(l)?l:{}),...Object.keys(object(r)?r:{}),...Object.keys(object(b)?b:{})]);
      for(const key of keys){
        const page=Number(key);
        if(!Number.isSafeInteger(page)||page<1){clash(path+' / '+key,'ページ状態が不正です');continue;}
        const a=pageEntry(l?.[key]),z=pageEntry(r?.[key]),ancestor=pageEntry(b?.[key]);let value;
        if(equal(a,z))value=z;
        else if(base&&equal(a,ancestor))value=z;
        else if(base&&equal(z,ancestor))value=a;
        else if(a.revision>z.revision)value=a;
        else if(z.revision>a.revision)value=z;
        else value={hidden:a.hidden&&z.hidden,revision:Math.max(a.revision,z.revision)+1,updatedAt:Math.max(a.updatedAt,z.updatedAt)};
        if(value.revision>0||value.hidden)out[String(page)]=copy(value);
      }
      return out;
    }"""
change(p,old,new)
change(p,
       "const st=properties(l.state,r.state,b?.state,path+' / 用紙・縮尺',['shapes',...viewKeys]);",
       "const st=properties(l.state,r.state,b?.state,path+' / 用紙・縮尺',['shapes','pageStates',...viewKeys]);\n      st.pageStates=mergePageStates(l.state.pageStates,r.state.pageStates,b?.state?.pageStates,path+' / ページ表示');")

# Drawing export: preserve the original PDF but omit hidden pages from record PDFs.
p='sentlog/drawing-export.js'
change(p,
       "  if(source&&source.getPageCount()!==info.count)throw Error('PDFのページ数が一致しません。');",
       "  if(source&&source.getPageCount()!==info.count)throw Error('PDFのページ数が一致しません。');\n  const pages=Array.from({length:info.count},(_,i)=>i+1).filter(n=>!item.state.pageStates?.[String(n)]?.hidden);\n  if(!pages.length)throw Error('表示するページがありません。ページ管理で1ページ以上を表示してください。');")
change(p,
       "  for(let n=1;n<=info.count;n++){check();unchanged(item);onPage(n,info.count);check();const data=await bounded(worker.api.page(n));check();await C.addPage(doc,source,data,P);}",
       "  for(let i=0;i<pages.length;i++){const n=pages[i];check();unchanged(item);onPage(i+1,pages.length);check();const data=await bounded(worker.api.page(n));check();await C.addPage(doc,source,data,P);}")
change(p,
       "unchanged(item);onStage('PDFをまとめています…');return {blob:new Blob([await doc.save()],{type:'application/pdf'}),pages:info.count};",
       "unchanged(item);onStage('PDFをまとめています…');return {blob:new Blob([await doc.save()],{type:'application/pdf'}),pages:pages.length};")

# Release/cache markers in regression fixtures.
for f in (ROOT/'tests').iterdir():
    if f.suffix not in ('.py','.cjs'):continue
    s=f.read_text()
    u=s.replace("'v1.91'","'v1.92'").replace('v1.91','v1.92')
    u=u.replace('phone-runtime.js?v=191','phone-runtime.js?v=192').replace(r'phone-runtime\.js\?v=191',r'phone-runtime\.js\?v=192')
    u=u.replace('sentlog-pwa-v202','sentlog-pwa-v203')
    if u!=s:f.write_text(u)

subprocess.run(['node','--check','sentlog/page-management.js'],cwd=ROOT,check=True)
subprocess.run(['node','--check','sentlog/sync-merge.js'],cwd=ROOT,check=True)
subprocess.run(['node','--check','sentlog/drawing-export.js'],cwd=ROOT,check=True)
subprocess.run(['node','tests/page_management.test.cjs'],cwd=ROOT,check=True)
print('Built Sentlog v1.92: reversible page visibility; source PDF and cloud asset unchanged')

/* Export iframe prelude: this document has no access to app persistence APIs. */
(function(){'use strict';
const values=new Map();
Object.defineProperty(window,'localStorage',{value:{getItem:k=>values.get(k)??null,setItem:(k,v)=>values.set(k,String(v)),removeItem:k=>values.delete(k),clear:()=>values.clear(),key:i=>[...values.keys()][i]??null,get length(){return values.size;}}});
Object.defineProperty(window,'indexedDB',{value:{open(){throw Error('出力画面から保存データは変更できません。');},deleteDatabase(){throw Error('出力画面から保存データは削除できません。');}}});
window.SentlogRecords={ready:true,getItem:k=>values.get(k)??null,setItem:(k,v)=>values.set(k,String(v)),removeItem:k=>values.delete(k),settled:async()=>{},assertSafe(){},writeFile:async()=>{throw Error('出力画面では原本を変更しません。');}};
const token=new URL(location.href).searchParams.get('job');
const input=window.parent!==window?window.parent.SentlogDrawingExport?.frameInput(token,window):null;
if(input)for(const [k,v] of Object.entries(input.preferences||{}))values.set(k,v);
window.sentlogExportInput=input;
})();

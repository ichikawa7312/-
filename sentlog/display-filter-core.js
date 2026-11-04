/* Sentlog display filter: pure, read-only record classification and selection. */
(function(root){'use strict';
function category(s){
 if(!s||typeof s!=='object')return 'その他';
 if(s.recordKind==='field-record')return s.recordType==='photo'?'写真位置':s.recordType==='survey'?'調査位置':'その他';
 if(s.recordKind==='dimension-line'||(s.recordKind==='drawing-memo'&&s.memoType==='dimension'))return '寸法線';
 if(s.recordKind==='drawing-memo')return 'メモ';
 return String(s.type||'その他').trim()||'その他';
}
function isVisible(s,filter){
 if(!filter)return true;
 if(!Array.isArray(filter.categories)||!filter.categories.includes(category(s)))return false;
 return !Array.isArray(filter.hiddenIds)||!filter.hiddenIds.includes(String(s?.id??''));
}
function categories(shapes){return [...new Set((shapes||[]).map(category))].sort((a,b)=>a.localeCompare(b,'ja'));}
function label(s){
 if(!s)return '';
 const cat=category(s);
 if(s.recordKind==='field-record')return String(s.autoLabel||cat+'-'+(s.typeNo||s.recordNo||'?'));
 if(cat==='寸法線')return String(s.manualText||s.text||'寸法線');
 if(cat==='メモ')return String(s.text||s.memoType||'メモ').slice(0,32);
 return String(s.autoLabel||s.no||cat);
}
function normalise(filter,shapes){
 const all=categories(shapes),requested=Array.isArray(filter?.categories)?filter.categories:all;
 const present=new Set((shapes||[]).map(s=>String(s.id??'')));
 return {categories:all.filter(c=>requested.includes(c)),hiddenIds:[...new Set((filter?.hiddenIds||[]).map(String))].filter(id=>present.has(id))};
}
function isAll(shapes,filter){return (shapes||[]).every(s=>isVisible(s,filter));}
const api={category,isVisible,categories,label,normalise,isAll};
if(typeof module==='object'&&module.exports)module.exports=api;
else root.SentlogDisplayFilterCore=api;
})(typeof window==='object'?window:globalThis);

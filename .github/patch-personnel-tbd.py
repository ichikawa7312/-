from pathlib import Path

p=Path('app.js')
t=p.read_text(encoding='utf-8')

# 1) Hide confirmation section while personnel are undecided.
old="function confHtml(s){\n  const ms=sm(s),done=ms.filter(x=>state(s,x.staff_id)[1]==='done').length;"
new="function confHtml(s){\n  if(s.personnel_tbd)return '';\n  const ms=sm(s),done=ms.filter(x=>state(s,x.staff_id)[1]==='done').length;"
assert old in t
t=t.replace(old,new,1)

# 2) Show a clear badge instead of an empty personnel row on detail cards.
old='<div class="chips">${sm(s).map(x=>`<span class="chip">${esc(st(x.staff_id)?.display_name)}</span>`).join(\'\')}</div>'
new='<div class="chips">${s.personnel_tbd?\'<span class="tbdBadge">人員未定</span>\':sm(s).map(x=>`<span class="chip">${esc(st(x.staff_id)?.display_name)}</span>`).join(\'\')}</div>'
assert old in t
t=t.replace(old,new,1)

# 3) Daily status: TBD sites make office status provisional and produce a warning.
old="  const scheduledIds=new Set();\n  schedules.filter(s=>s.work_date===date).forEach(s=>sm(s).forEach(x=>scheduledIds.add(x.staff_id)));"
new="  const tbdCount=schedules.filter(s=>s.work_date===date&&s.personnel_tbd).length;\n  const scheduledIds=new Set();\n  schedules.filter(s=>s.work_date===date&&!s.personnel_tbd).forEach(s=>sm(s).forEach(x=>scheduledIds.add(x.staff_id)));"
assert old in t
t=t.replace(old,new,1)

old='<div style="margin-top:7px"><b>事務所 ${office.length}名</b><div style="font-size:12px;color:#4b5563;margin-top:2px">${names(office)}</div></div>'
new='<div style="margin-top:7px"><b>事務所 ${office.length}名${tbdCount?\'（暫定）\':\'\'}</b><div style="font-size:12px;color:#4b5563;margin-top:2px">${names(office)}</div></div>'
assert old in t
t=t.replace(old,new,1)

old='    <div style="margin-top:7px"><b>休み ${off.length}名</b><div style="font-size:12px;color:#4b5563;margin-top:2px">${names(off)}</div></div>\n    ${overlap.length?`<div style="margin-top:8px;padding:7px;border-radius:8px;background:#fff7ed;font-size:11px"><b>⚠ 休みと現場予定が重複：</b>${names(overlap)}</div>`:\'\'}'
new='    <div style="margin-top:7px"><b>休み ${off.length}名</b><div style="font-size:12px;color:#4b5563;margin-top:2px">${names(off)}</div></div>\n    ${tbdCount?`<div class="statuswarn"><b>⚠ 人員未定の現場 ${tbdCount}件</b><br>事務所表示の人が現場に入る可能性があります。</div>`:\'\'}\n    ${overlap.length?`<div style="margin-top:8px;padding:7px;border-radius:8px;background:#fff7ed;font-size:11px"><b>⚠ 休みと現場予定が重複：</b>${names(overlap)}</div>`:\'\'}'
assert old in t
t=t.replace(old,new,1)

# 4) Both compact lists show the TBD badge.
old="    const people=sm(s).map(x=>st(x.staff_id)?.display_name).filter(Boolean).map(esc).join('・')||'—';"
new="    const people=s.personnel_tbd?'<span class=\"tbdBadge\">人員未定</span>':(sm(s).map(x=>st(x.staff_id)?.display_name).filter(Boolean).map(esc).join('・')||'—');"
count=t.count(old)
assert count>=2, count
t=t.replace(old,new,2)

# 5) A TBD site is visible to everyone even while the home view is set to 自分.
old="function visible(){return schedules.filter(s=>!onlyMine||assigned(s))}"
new="function visible(){return schedules.filter(s=>!onlyMine||assigned(s)||s.personnel_tbd)}"
assert old in t
t=t.replace(old,new,1)

# 6) Replace personnel picker with two explicit modes.
old='    <label>現場人員<div class="staff">${checks(sel)}</div></label>'
new='''    <div class="formgroup"><div class="formlabel">現場人員</div>
      <input id="personnelTbd" type="hidden" value="${s?.personnel_tbd?'1':'0'}">
      <div class="personmode"><button type="button" id="modeSelect" class="modebtn">人員を選択</button><button type="button" id="modeTbd" class="modebtn">人員未定</button></div>
      <div id="staffBox" class="staff">${checks(sel)}</div>
      <small id="personHint" class="personhint"></small>
    </div>'''
assert old in t
t=t.replace(old,new,1)

old="  wireDateRows();\n\n  $('addNextDate').onclick=()=>{"
new="""  const syncPersonnelMode=()=>{\n    const tbd=$('personnelTbd').value==='1';\n    $('modeSelect').classList.toggle('on',!tbd);\n    $('modeTbd').classList.toggle('on',tbd);\n    $('staffBox').classList.toggle('hide',tbd);\n    $('personHint').textContent=tbd?'人員が決まったら、この予定を編集して担当者を選択してください。':'担当する人を選択してください。';\n  };\n  $('modeSelect').onclick=()=>{$('personnelTbd').value='0';syncPersonnelMode()};\n  $('modeTbd').onclick=()=>{$('personnelTbd').value='1';syncPersonnelMode()};\n  syncPersonnelMode();\n\n  wireDateRows();\n\n  $('addNextDate').onclick=()=>{"""
assert old in t
t=t.replace(old,new,1)

# 7) Saving: personnel selection is required only in selected mode.
old="  const sel=[...document.querySelectorAll('input[name=\"staff\"]:checked')].map(x=>x.value);\n  if(!sel.length)return toast('現場人員を選択してください');"
new="  const personnelTbd=$('personnelTbd').value==='1';\n  const picked=[...document.querySelectorAll('input[name=\"staff\"]:checked')].map(x=>x.value);\n  const sel=personnelTbd?[]:picked;\n  if(!personnelTbd&&!sel.length)return toast('現場人員を選択してください');"
assert old in t
t=t.replace(old,new,1)

old="    pdf_name:pname,\n    updated_by:me.id"
new="    pdf_name:pname,\n    personnel_tbd:personnelTbd,\n    updated_by:me.id"
assert old in t
t=t.replace(old,new,1)

old="      s.pdf_path!==common.pdf_path||\n      s.pdf_name!==common.pdf_name||\n      membersChanged;"
new="      s.pdf_path!==common.pdf_path||\n      s.pdf_name!==common.pdf_name||\n      Boolean(s.personnel_tbd)!==personnelTbd||\n      membersChanged;"
assert old in t
t=t.replace(old,new,1)

old="""    if(membersChanged){\n      await db.from('schedule_members').delete().eq('schedule_id',s.id);\n      r=await db.from('schedule_members').insert(sel.map(staff_id=>({schedule_id:s.id,staff_id})));\n      if(r.error)return toast('人員保存失敗');\n    }"""
new="""    if(membersChanged){\n      r=await db.from('schedule_members').delete().eq('schedule_id',s.id);\n      if(r.error)return toast('人員保存失敗');\n      if(sel.length){\n        r=await db.from('schedule_members').insert(sel.map(staff_id=>({schedule_id:s.id,staff_id})));\n        if(r.error)return toast('人員保存失敗');\n      }\n    }"""
assert old in t
t=t.replace(old,new,1)

old="""      const memberRows=rows.flatMap(row=>sel.map(staff_id=>({\n        schedule_id:row.id,\n        staff_id\n      })));\n      r=await db.from('schedule_members').insert(memberRows);\n      if(r.error)return toast('追加日の人員保存に失敗しました');"""
new="""      const memberRows=rows.flatMap(row=>sel.map(staff_id=>({\n        schedule_id:row.id,\n        staff_id\n      })));\n      if(memberRows.length){\n        r=await db.from('schedule_members').insert(memberRows);\n        if(r.error)return toast('追加日の人員保存に失敗しました');\n      }"""
assert old in t
t=t.replace(old,new,1)

old="""  const memberRows=rows.flatMap(row=>sel.map(staff_id=>({\n    schedule_id:row.id,\n    staff_id\n  })));\n  r=await db.from('schedule_members').insert(memberRows);\n  if(r.error)return toast('人員保存失敗');"""
new="""  const memberRows=rows.flatMap(row=>sel.map(staff_id=>({\n    schedule_id:row.id,\n    staff_id\n  })));\n  if(memberRows.length){\n    r=await db.from('schedule_members').insert(memberRows);\n    if(r.error)return toast('人員保存失敗');\n  }"""
assert old in t
t=t.replace(old,new,1)

p.write_text(t,encoding='utf-8')

# Styling.
css=Path('app.css')
c=css.read_text(encoding='utf-8')
add='''.formgroup{display:grid;gap:6px}.formlabel{font-size:11px;font-weight:800;color:#475569}.personmode{display:grid;grid-template-columns:1fr 1fr;gap:7px}.modebtn{border:1px solid var(--line);border-radius:10px;background:#fff;color:#475569;padding:10px 8px;font-weight:800;font-size:12px}.modebtn.on{background:var(--ink);border-color:var(--ink);color:#fff}.personhint{color:var(--mut);font-size:10px;line-height:1.45}.tbdBadge{display:inline-flex;align-items:center;width:max-content;border:1px solid #fed7aa;background:#fff7ed;color:#b45309;border-radius:999px;padding:4px 8px;font-size:10px;font-weight:900;white-space:nowrap}.statuswarn{margin-top:8px;padding:8px;border:1px solid #fed7aa;border-radius:9px;background:#fff7ed;color:#9a3412;font-size:11px;line-height:1.45}'''
if '.personmode{' not in c:
    c+='\n'+add+'\n'
css.write_text(c,encoding='utf-8')

# Cache bust.
idx=Path('index.html')
i=idx.read_text(encoding='utf-8').replace('20260814-2017','20260814-2025')
idx.write_text(i,encoding='utf-8')

sw=Path('sw.js')
swtext=sw.read_text(encoding='utf-8').replace("shinwa-yotei-v9","shinwa-yotei-v10").replace('20260814-2017','20260814-2025')
sw.write_text(swtext,encoding='utf-8')

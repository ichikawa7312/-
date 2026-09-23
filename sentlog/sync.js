(() => {
  const SUPABASE_URL = 'https://wiulvaqixphuobdielyy.supabase.co';
  const SUPABASE_KEY = 'sb_publishable_4pCeFn-wPsEYzFLhCMCINw_VEUfxz0-';
  const SDK_URL = 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.111.0/+esm';
  const QUEUE_KEY = 'sentlogCloudUploadQueueV1';
  const PROJECT_MAP_KEY = 'sentlogCloudProjectMapV1';
  const DEVICE_KEY = 'sentlogCloudDeviceIdV1';
  const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

  let cloud = null;
  let session = null;
  let syncing = false;
  let cloudBtn = null;
  let cloudModal = null;
  let cloudMessage = null;
  let deviceId = localStorage.getItem(DEVICE_KEY) || null;
  let sdkReady = false;

  const readJson = (key, fallback) => {
    try { return JSON.parse(localStorage.getItem(key) || '') || fallback; } catch { return fallback; }
  };
  const writeJson = (key, value) => localStorage.setItem(key, JSON.stringify(value));

  function queue() { return readJson(QUEUE_KEY, []); }
  function saveQueue(items) { writeJson(QUEUE_KEY, items); updateCloudButton(); }

  function deviceType() {
    const ua = navigator.userAgent || '';
    const ipad = /iPad/i.test(ua) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
    if (ipad) return 'ipad';
    if (/iPhone/i.test(ua)) return 'iphone';
    return 'browser';
  }
  function deviceName() {
    const type = deviceType();
    if (type === 'ipad') return 'iPad';
    if (type === 'iphone') return 'iPhone';
    return 'Web ' + (navigator.platform || '端末');
  }
  function esc(s) {
    return String(s ?? '').replace(/[&<>"']/g, m => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[m]));
  }
  function setCloudMessage(text, bad=false) {
    if (!cloudMessage) return;
    cloudMessage.textContent = text || '';
    cloudMessage.style.color = bad ? '#b91c1c' : '#4b5563';
  }
  function updateCloudButton() {
    if (!cloudBtn) return;
    const q = queue().length;
    if (!sdkReady) {
      cloudBtn.textContent = 'クラウド:準備中';
      return;
    }
    if (!session) {
      cloudBtn.textContent = q ? `クラウド未接続・待機 ${q}` : 'クラウド設定';
      return;
    }
    cloudBtn.textContent = q ? `同期待ち ${q}` : 'クラウド同期 ✓';
  }

  function injectUi() {
    const style = document.createElement('style');
    style.textContent = `
      #sentlogCloudBtn{background:#374151;color:#fff;border-color:#4b5563;padding:7px 10px;font-size:12px;white-space:nowrap}
      #sentlogCloudModal{position:fixed;inset:0;z-index:90;background:rgba(0,0,0,.48);display:none;align-items:center;justify-content:center;padding:18px}
      #sentlogCloudModal.open{display:flex}
      #sentlogCloudCard{width:min(460px,100%);max-height:88vh;overflow:auto;background:#fff;color:#111827;border-radius:14px;padding:18px;box-shadow:0 24px 70px rgba(0,0,0,.3)}
      #sentlogCloudCard h2{font-size:18px;margin:0 0 5px}
      #sentlogCloudCard p{font-size:12px;color:#6b7280;line-height:1.55}
      #sentlogCloudCard label{display:block;font-size:12px;color:#6b7280;margin:10px 0 4px}
      #sentlogCloudCard input{width:100%;padding:10px;border:1px solid #d1d5db;border-radius:8px;font:inherit}
      #sentlogCloudCard .cloud-actions{display:flex;gap:8px;flex-wrap:wrap;margin-top:12px}
      #sentlogCloudCard button{flex:1;min-width:120px}
      #sentlogCloudCard .primary{background:#111827;color:white;border-color:#111827}
      #sentlogCloudCard .cloud-box{margin-top:12px;border:1px solid #e5e7eb;border-radius:10px;padding:10px;background:#f9fafb;font-size:12px;line-height:1.55}
      #sentlogCloudCard .cloud-close{float:right;width:auto;min-width:0;padding:6px 10px}
      #sentlogCloudMessage{min-height:18px;margin-top:8px;font-size:12px}
      .sentlog-cloud-note{margin:12px 0;border:1px solid #bfdbfe;background:#eff6ff;color:#1e3a8a;border-radius:10px;padding:10px;font-size:12px;line-height:1.5}
    `;
    document.head.appendChild(style);

    const header = document.querySelector('header');
    if (header) {
      cloudBtn = document.createElement('button');
      cloudBtn.id = 'sentlogCloudBtn';
      cloudBtn.type = 'button';
      cloudBtn.textContent = 'クラウド設定';
      cloudBtn.onclick = openCloudModal;
      const status = document.getElementById('saveStatus');
      if (status) header.insertBefore(cloudBtn, status);
      else header.appendChild(cloudBtn);
    }

    cloudModal = document.createElement('div');
    cloudModal.id = 'sentlogCloudModal';
    cloudModal.innerHTML = `
      <div id="sentlogCloudCard">
        <button type="button" class="cloud-close" id="sentlogCloudClose">閉じる</button>
        <h2>セントログ クラウド同期</h2>
        <p>写真はまずこの端末に保存され、通信できるときだけ一時的にクラウドへ送信されます。会社PCが保存・照合した写真はクラウド本体から削除されます。</p>
        <div id="sentlogCloudSignedOut">
          <label>メールアドレス</label>
          <input id="sentlogCloudEmail" type="email" autocomplete="username" placeholder="メールアドレス">
          <label>パスワード</label>
          <input id="sentlogCloudPassword" type="password" autocomplete="current-password" minlength="8" placeholder="8文字以上">
          <div class="cloud-actions">
            <button type="button" class="primary" id="sentlogCloudLogin">ログイン</button>
            <button type="button" id="sentlogCloudSignup">初回登録</button>
          </div>
        </div>
        <div id="sentlogCloudSignedIn" style="display:none">
          <div class="cloud-box">
            <b id="sentlogCloudUser"></b><br>
            <span id="sentlogCloudQueue"></span><br>
            <span id="sentlogCloudServer"></span>
          </div>
          <div class="cloud-actions">
            <button type="button" class="primary" id="sentlogCloudRetry">今すぐ同期</button>
            <button type="button" id="sentlogCloudLogout">ログアウト</button>
          </div>
        </div>
        <div id="sentlogCloudMessage"></div>
      </div>`;
    document.body.appendChild(cloudModal);
    cloudMessage = document.getElementById('sentlogCloudMessage');
    document.getElementById('sentlogCloudClose').onclick = closeCloudModal;
    cloudModal.addEventListener('pointerdown', e => { if (e.target === cloudModal) closeCloudModal(); });
    document.getElementById('sentlogCloudLogin').onclick = login;
    document.getElementById('sentlogCloudSignup').onclick = signup;
    document.getElementById('sentlogCloudLogout').onclick = logout;
    document.getElementById('sentlogCloudRetry').onclick = () => syncQueue(true);

    const pill = document.querySelector('header .pill');
    if (pill && /試作版/.test(pill.textContent || '')) pill.textContent = '試作版 v1.18';

    const manager = document.querySelector('#projectsView .manager-shell');
    if (manager) {
      const note = document.createElement('div');
      note.className = 'sentlog-cloud-note';
      note.innerHTML = '<b>写真の自動保管</b>　端末保存 → 一時クラウド → 会社PC保存・照合 → クラウド写真削除、の順で動きます。圏外中は端末内に待機します。';
      const head = manager.querySelector('.manager-head');
      if (head) head.insertAdjacentElement('afterend', note);
    }
  }

  function openCloudModal() {
    if (!cloudModal) return;
    cloudModal.classList.add('open');
    renderCloudModal();
    refreshServerCounts();
  }
  function closeCloudModal() { cloudModal?.classList.remove('open'); }

  async function renderCloudModal() {
    const out = document.getElementById('sentlogCloudSignedOut');
    const inn = document.getElementById('sentlogCloudSignedIn');
    if (!out || !inn) return;
    out.style.display = session ? 'none' : 'block';
    inn.style.display = session ? 'block' : 'none';
    if (session) {
      document.getElementById('sentlogCloudUser').textContent = session.user.email || 'ログイン済み';
      document.getElementById('sentlogCloudQueue').textContent = `この端末の送信待ち：${queue().length}件`;
    }
    updateCloudButton();
  }

  async function login() {
    if (!cloud) return;
    setCloudMessage('ログイン中…');
    const email = document.getElementById('sentlogCloudEmail').value.trim();
    const password = document.getElementById('sentlogCloudPassword').value;
    const { data, error } = await cloud.auth.signInWithPassword({ email, password });
    if (error) return setCloudMessage('ログインできません：' + error.message, true);
    session = data.session;
    setCloudMessage('ログインしました。');
    await afterAuth();
  }

  async function signup() {
    if (!cloud) return;
    setCloudMessage('登録中…');
    const email = document.getElementById('sentlogCloudEmail').value.trim();
    const password = document.getElementById('sentlogCloudPassword').value;
    if (!email || password.length < 8) return setCloudMessage('メールアドレスと8文字以上のパスワードを入力してください。', true);
    const { data, error } = await cloud.auth.signUp({ email, password });
    if (error) return setCloudMessage('登録できません：' + error.message, true);
    session = data.session;
    if (!session) {
      setCloudMessage('確認メールを送りました。メール内のリンクを開いた後、この画面でログインしてください。');
      return;
    }
    setCloudMessage('登録してログインしました。');
    await afterAuth();
  }

  async function logout() {
    if (!cloud) return;
    await cloud.auth.signOut();
    session = null;
    deviceId = null;
    localStorage.removeItem(DEVICE_KEY);
    setCloudMessage('ログアウトしました。');
    renderCloudModal();
  }

  async function afterAuth() {
    await ensureDevice();
    await renderCloudModal();
    await syncQueue(true);
    await refreshServerCounts();
  }

  async function ensureDevice() {
    if (!session || !cloud) return null;
    if (deviceId) {
      const { data } = await cloud.from('sentlog_devices').select('id').eq('id', deviceId).maybeSingle();
      if (data?.id) return deviceId;
      deviceId = null;
      localStorage.removeItem(DEVICE_KEY);
    }
    const { data, error } = await cloud.rpc('sentlog_register_device', {
      p_device_name: deviceName(),
      p_device_type: deviceType()
    });
    if (error) throw error;
    deviceId = data;
    localStorage.setItem(DEVICE_KEY, deviceId);
    return deviceId;
  }

  function projectMap() { return readJson(PROJECT_MAP_KEY, {}); }
  function saveProjectMap(v) { writeJson(PROJECT_MAP_KEY, v); }

  async function ensureCloudProject(localProjectId) {
    if (!session) throw new Error('not_signed_in');
    const map = projectMap();
    const mapped = map[localProjectId];
    if (mapped) {
      const { data } = await cloud.from('sentlog_projects').select('id').eq('id', mapped).maybeSingle();
      if (data?.id) return mapped;
    }
    const p = (workspace?.projects || []).find(x => x.id === localProjectId);
    if (!p) throw new Error('local_project_not_found');
    const { data, error } = await cloud.from('sentlog_projects')
      .insert({ owner_id: session.user.id, name: p.name || '案件' })
      .select('id').single();
    if (error) throw error;
    map[localProjectId] = data.id;
    saveProjectMap(map);
    return data.id;
  }

  function drawingStateFor(drawingId) {
    if (typeof activeDrawingId !== 'undefined' && activeDrawingId === drawingId && typeof state !== 'undefined') return state;
    try { return JSON.parse(localStorage.getItem('surveyFieldNoteDrawingV1:' + drawingId) || 'null'); } catch { return null; }
  }

  function persistDrawingState(drawingId, st) {
    if (!st) return;
    if (typeof activeDrawingId !== 'undefined' && activeDrawingId === drawingId && typeof state !== 'undefined') {
      state = st;
      try { persist(); } catch { localStorage.setItem('surveyFieldNoteDrawingV1:' + drawingId, JSON.stringify(st)); }
    } else {
      localStorage.setItem('surveyFieldNoteDrawingV1:' + drawingId, JSON.stringify(st));
    }
  }

  function findPhotoContext(item) {
    const st = drawingStateFor(item.drawingId);
    if (!st) return null;
    const shape = (st.shapes || []).find(s => s.id === item.shapeId);
    const photo = shape?.photos?.find(p => p.id === item.photoId);
    if (!shape || !photo) return null;
    return { st, shape, photo };
  }

  function archiveFileName(name, mime, photoId) {
    const clean = String(name || 'photo').replace(/[\\/:*?"<>|]+/g, '_').trim() || 'photo';
    const base = clean.replace(/\.[^.]+$/, '');
    let ext = clean.includes('.') ? '.' + clean.split('.').pop() : '';
    if (mime === 'image/jpeg') ext = '.jpg';
    else if (mime === 'image/png') ext = '.png';
    else if (mime === 'image/webp') ext = '.webp';
    if (!ext) ext = '.bin';
    return `${base}_${String(photoId).slice(0,8)}${ext}`;
  }

  async function sha256(blob) {
    const buf = await blob.arrayBuffer();
    const digest = await crypto.subtle.digest('SHA-256', buf);
    return [...new Uint8Array(digest)].map(b => b.toString(16).padStart(2, '0')).join('');
  }

  function enqueuePhoto(projectLocalId, drawingId, shapeId, photoId) {
    const items = queue();
    if (items.some(x => x.drawingId === drawingId && x.photoId === photoId)) return;
    items.push({ id: crypto.randomUUID(), projectLocalId, drawingId, shapeId, photoId, assetId: UUID_RE.test(photoId) ? photoId : crypto.randomUUID(), queuedAt: Date.now(), attempts: 0 });
    saveQueue(items);
  }

  async function syncOne(item) {
    const ctx = findPhotoContext(item);
    if (!ctx) throw new Error('写真情報が見つかりません');
    const blob = await getPhotoBlob(item.photoId, item.drawingId);
    if (!blob) throw new Error('写真本体が端末に見つかりません');

    const cloudProjectId = await ensureCloudProject(item.projectLocalId);
    await ensureDevice();

    const mime = blob.type || ctx.photo.type || 'image/jpeg';
    const fileName = archiveFileName(ctx.photo.name, mime, item.photoId);
    const hash = await sha256(blob);
    const path = `${session.user.id}/${cloudProjectId}/${item.assetId}/${fileName}`;

    const { error: uploadError } = await cloud.storage.from('sentlog-temp').upload(path, blob, {
      upsert: true,
      contentType: mime,
      cacheControl: '3600'
    });
    if (uploadError) throw uploadError;

    const meta = {
      local_project_id: item.projectLocalId,
      local_drawing_id: item.drawingId,
      local_shape_id: item.shapeId,
      local_photo_id: item.photoId,
      damage_type: ctx.shape.type || '',
      global_no: ctx.shape.globalNo || null,
      type_no: ctx.shape.typeNo || null,
      auto_label: ctx.shape.autoLabel || '',
      member: ctx.shape.member || '',
      memo: ctx.shape.memo || ''
    };

    const row = {
      id: item.assetId,
      owner_id: session.user.id,
      project_id: cloudProjectId,
      source_device_id: deviceId,
      kind: 'photo',
      file_name: fileName,
      storage_path: path,
      mime_type: mime,
      byte_size: blob.size,
      sha256: hash,
      status: 'uploaded',
      captured_at: ctx.photo.createdAt ? new Date(ctx.photo.createdAt).toISOString() : new Date().toISOString(),
      metadata: meta
    };

    const { error: rowError } = await cloud.from('sentlog_assets').upsert(row, { onConflict: 'id' });
    if (rowError) {
      try { await cloud.storage.from('sentlog-temp').remove([path]); } catch {}
      throw rowError;
    }

    ctx.photo.cloud = { assetId: item.assetId, status: 'uploaded', uploadedAt: Date.now(), sha256: hash };
    persistDrawingState(item.drawingId, ctx.st);
  }

  async function syncQueue(force=false) {
    if (!cloud || !session || syncing) return;
    if (!navigator.onLine && !force) return;
    syncing = true;
    updateCloudButton();
    try {
      await ensureDevice();
      let items = queue();
      for (const item of [...items]) {
        try {
          await syncOne(item);
          items = queue().filter(x => x.id !== item.id);
          saveQueue(items);
          setCloudMessage('写真をクラウドへ送信しました。会社PCの回収待ちです。');
        } catch (e) {
          const current = queue();
          const hit = current.find(x => x.id === item.id);
          if (hit) {
            hit.attempts = (hit.attempts || 0) + 1;
            hit.lastError = String(e?.message || e);
            hit.lastAttemptAt = Date.now();
            saveQueue(current);
          }
          if (navigator.onLine) console.warn('Sentlog cloud sync failed', e);
        }
      }
      await refreshServerCounts();
    } finally {
      syncing = false;
      updateCloudButton();
      renderCloudModal();
    }
  }

  async function refreshServerCounts() {
    if (!cloud || !session) return;
    const el = document.getElementById('sentlogCloudServer');
    if (!el) return;
    try {
      const { count: waitCount } = await cloud.from('sentlog_assets').select('id', { count: 'exact', head: true }).eq('status', 'uploaded');
      const { count: pcCount } = await cloud.from('sentlog_assets').select('id', { count: 'exact', head: true }).eq('status', 'pc_verified');
      el.textContent = `会社PC回収待ち：${waitCount || 0}件 / PC保存済み・削除待ち：${pcCount || 0}件`;
    } catch {
      el.textContent = 'クラウド状態を取得できませんでした。';
    }
  }

  async function hookPhotoSave() {
    if (typeof addPhotosToSelected !== 'function') return;
    const original = addPhotosToSelected;
    addPhotosToSelected = async function(files) {
      const targetShapeId = typeof selected !== 'undefined' ? selected : null;
      const projectLocalId = typeof activeProjectId !== 'undefined' ? activeProjectId : null;
      const drawingId = typeof activeDrawingId !== 'undefined' ? activeDrawingId : null;
      const before = new Set(((typeof state !== 'undefined' ? state.shapes : []) || []).find(s => s.id === targetShapeId)?.photos?.map(p => p.id) || []);
      await original(files);
      if (!targetShapeId || !projectLocalId || !drawingId) return;
      const s = ((typeof state !== 'undefined' ? state.shapes : []) || []).find(x => x.id === targetShapeId);
      for (const p of (s?.photos || [])) {
        if (!before.has(p.id) && !p.cloud?.assetId) enqueuePhoto(projectLocalId, drawingId, targetShapeId, p.id);
      }
      syncQueue();
    };
  }

  async function start() {
    injectUi();
    updateCloudButton();
    try {
      const mod = await import(SDK_URL);
      cloud = mod.createClient(SUPABASE_URL, SUPABASE_KEY, {
        auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true }
      });
      sdkReady = true;
      const { data } = await cloud.auth.getSession();
      session = data.session;
      cloud.auth.onAuthStateChange((_event, nextSession) => {
        session = nextSession;
        updateCloudButton();
        renderCloudModal();
        if (session) setTimeout(() => afterAuth().catch(console.warn), 50);
      });
      if (session) await afterAuth();
      await hookPhotoSave();
      window.addEventListener('online', () => syncQueue(true));
      setInterval(() => { if (session && navigator.onLine) syncQueue(); }, 20000);
    } catch (e) {
      console.warn('Sentlog cloud module unavailable', e);
      sdkReady = false;
      updateCloudButton();
      setCloudMessage('クラウド機能を読み込めませんでした。ローカル機能はそのまま使えます。', true);
      await hookPhotoSave();
    }
  }

  setTimeout(start, 0);
})();
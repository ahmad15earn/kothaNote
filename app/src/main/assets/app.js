/* =========================================================
   KothaNote — real on-device voice notes
   Recording, transcription, playback and export are handled by
   the native Android layer through window.Android.
   No demo notes, no sample text, no simulated audio.
   ========================================================= */
(function () {
  'use strict';

  const $ = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => Array.from(r.querySelectorAll(s));

  const CATS = ['Quick', 'Meeting', 'Idea', 'Personal'];
  const LANGS = { bn: 'বাংলা', en: 'English', auto: 'Auto' };
  const NOTE_KEY = 'kothanote.notes.v2';
  const LANG_KEY = 'kothanote.lang.v1';
  const PROFILE_KEY = 'kothanote.profile.v1';
  const USAGE_KEY = 'kothanote.usage.v1';
  const AUDIO_RE = /^[A-Za-z0-9._-]{1,90}\.wav$/;

  const hasNative = () => {
    try {
      return !!(window.Android && window.Android.isNative && window.Android.isNative());
    } catch (e) {
      return false;
    }
  };
  const NATIVE = hasNative();

  function nativeJson(value) {
    try { return JSON.parse(value); } catch (e) { return null; }
  }

  /* ---------- tiny helpers ---------- */
  const fmt = s => {
    const total = Math.max(0, Math.floor(Number(s) || 0));
    return Math.floor(total / 60) + ':' + String(total % 60).padStart(2, '0');
  };
  const isToday = t => new Date(t).toDateString() === new Date().toDateString();
  const hasBn = x => /[\u0980-\u09FF]/.test(x || '');
  const titleOf = x => {
    const w = (x || '').trim().split(/\s+/).filter(Boolean);
    if (!w.length) return 'Voice note';
    return w.slice(0, 5).join(' ') + (w.length > 5 ? '…' : '');
  };
  const stamp = t => isToday(t)
    ? new Date(t).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })
    : new Date(t).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });

  function storeGet(k) { try { return localStorage.getItem(k); } catch (e) { return null; } }
  function storeSet(k, v) { try { localStorage.setItem(k, v); return true; } catch (e) { return false; } }

  /* ---------- data ---------- */
  // The previous demo build stored sample notes in v1. They are removed on
  // purpose: a fresh install starts with an empty list and every visible note
  // from now on comes from a real recording.
  try { localStorage.removeItem('kothanote.notes.v1'); } catch (e) {}

  function normalizeNote(n) {
    if (!n || typeof n !== 'object') return null;
    if (typeof n.id !== 'number' || typeof n.t !== 'number' || typeof n.d !== 'number') return null;
    if (typeof n.x !== 'string' || !CATS.includes(n.c)) return null;
    const f = typeof n.f === 'string' ? n.f : '';
    if (f && !AUDIO_RE.test(f)) return null;
    const pf = typeof n.pf === 'string' && AUDIO_RE.test(n.pf) ? n.pf : '';
    if (!f && !pf && !n.x) return null;
    const out = {
      id: n.id,
      c: n.c,
      t: n.t,
      d: Math.max(0, n.d),
      x: n.x,
      f
    };
    if (n.p === 1 || n.p === true) out.p = 1;
    if (pf) out.pf = pf;
    if (n.l === 'bn' || n.l === 'en' || n.l === 'auto') out.l = n.l;
    if (n.pl === 'bn' || n.pl === 'en' || n.pl === 'auto') out.pl = n.pl;
    if (typeof n.e === 'string' && n.e) out.e = n.e;
    return out;
  }

  function loadNotes() {
    const raw = storeGet(NOTE_KEY);
    if (!raw) return [];
    try {
      const arr = JSON.parse(raw);
      if (!Array.isArray(arr)) return [];
      return arr.map(normalizeNote).filter(Boolean);
    } catch (e) {
      return [];
    }
  }

  let notes = loadNotes();
  let nextId = notes.reduce((m, n) => Math.max(m, n.id), 0) + 1;

  function saveNotes() {
    const ok = storeSet(NOTE_KEY, JSON.stringify(notes));
    if (!ok) toast('Could not save. This phone may be out of space.');
    return ok;
  }

  const noteById = id => notes.find(n => n.id === id);

  /* ---------- profile ---------- */
  function cleanName(value) {
    return String(value || '').replace(/\s+/g, ' ').trim().slice(0, 28);
  }
  let profileName = '';
  try {
    const saved = JSON.parse(storeGet(PROFILE_KEY) || '{}');
    if (saved && typeof saved.name === 'string') profileName = cleanName(saved.name);
  } catch (e) {}

  /* ---------- usage log ---------- */
  const pad2 = n => String(n).padStart(2, '0');
  const dayKey = t => {
    const d = new Date(t);
    return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate());
  };
  let usage = {};
  try {
    const saved = JSON.parse(storeGet(USAGE_KEY) || '{}');
    if (saved && typeof saved === 'object' && !Array.isArray(saved)) {
      Object.keys(saved).forEach(k => {
        const value = Number(saved[k]);
        if (value > 0) usage[k] = Math.floor(value);
      });
    }
  } catch (e) {}
  // First run after an upgrade: seed the graph from the notes that already
  // exist, then keep a separate log so deleting a note does not erase the
  // record of having used the app that day.
  if (storeGet(USAGE_KEY) === null) {
    notes.forEach(n => {
      const k = dayKey(n.t);
      usage[k] = (usage[k] || 0) + 1;
    });
    storeSet(USAGE_KEY, JSON.stringify(usage));
  }
  function bumpUsage() {
    const k = dayKey(Date.now());
    usage[k] = (usage[k] || 0) + 1;
    storeSet(USAGE_KEY, JSON.stringify(usage));
    renderUsage();
  }

  /* ---------- cloud transcription ---------- */
  const cloud = {
    configured: false,
    online: true,
    masked: '',
    model: 'gemini-2.5-flash',
    busy: false,
    poll: null,
    timeout: null
  };

  function refreshCloud(repaint) {
    if (!NATIVE) {
      cloud.online = navigator.onLine !== false;
      return;
    }
    let cfg = null;
    try { cfg = nativeJson(window.Android.cloudConfig()); } catch (e) {}
    if (cfg) {
      cloud.configured = !!cfg.configured;
      cloud.online = cfg.online !== false;
      cloud.masked = cfg.masked || '';
      cloud.model = cfg.model === 'gemini-2.5-pro' ? 'gemini-2.5-pro' : 'gemini-2.5-flash';
    }
    if (repaint !== false) paintCloudRow();
  }

  function pendingCount() {
    return notes.filter(n => n.p && (n.pf || n.f)).length;
  }

  function cloudStatusText() {
    if (!cloud.configured) return 'Set up';
    if (!cloud.online) return 'Waiting for internet';
    return 'On · Gemini';
  }

  function paintCloudRow() {
    const row = $('#cloudStatus');
    if (row) row.textContent = cloudStatusText();
  }

  function noteAudio(n) {
    return n.pf || n.f || '';
  }

  function updateNoteIfOpen(n) {
    if (current === 'detail' && curNoteId === n.id) openNote(n.id, true);
  }

  function finishCloudNote(n, text) {
    if (!noteById(n.id)) return false;
    let merged = false;
    if (n.pf) {
      let res = null;
      try { res = nativeJson(window.Android.mergeAudio(n.f, n.pf)); } catch (e) {}
      if (!res || !res.ok) {
        n.e = 'The recording could not be joined. Tap to try again.';
        saveNotes();
        updateNoteIfOpen(n);
        toast(n.e);
        return false;
      }
      n.f = res.file || n.f;
      n.d = Math.max(1, Math.round((Number(res.durationMs) || 0) / 1000));
      delete n.pf;
      merged = true;
    }
    const clean = String(text || '').trim();
    if (!clean) {
      n.e = 'No words were heard. The recording is safe.';
      saveNotes();
      updateNoteIfOpen(n);
      return false;
    }
    n.x = (n.x ? n.x + '\n\n' : '') + clean;
    delete n.p;
    delete n.e;
    delete n.pl;
    if (typeof n.f !== 'string') n.f = '';
    if (!n.d || n.d < 1) n.d = Math.max(1, Math.round(clean.split(/\s+/).length / 2.6));
    saveNotes();
    updateStorage();
    homeDirty = false;
    if (current === 'home') renderHome();
    updateNoteIfOpen(n);
    toast(merged ? 'Added to note' : 'Transcript ready');
    return true;
  }

  function stopCloudPoll() {
    clearInterval(cloud.poll);
    clearTimeout(cloud.timeout);
    cloud.poll = null;
    cloud.timeout = null;
    cloud.busy = false;
  }

  function startCloudNote(n) {
    const file = noteAudio(n);
    if (!file) return false;
    try {
      window.Android.startCloudTranscribe(file, n.pl || n.l || lang, cloud.model);
    } catch (e) {
      return false;
    }
    cloud.busy = true;
    cloud.poll = setInterval(() => {
      let st = null;
      try { st = nativeJson(window.Android.cloudJobStatus()); } catch (e) {}
      if (!st) return;
      if (st.state === 'running') {
        if (current === 'detail' && curNoteId === n.id) {
          const pct = Number(st.progress) || 0;
          $('#dX').textContent = (st.message || 'Transcribing with Gemini…')
            + (pct > 0 ? ' ' + pct + '%' : '');
        }
        return;
      }
      stopCloudPoll();
      if (st.state === 'done') {
        finishCloudNote(n, st.text);
        setTimeout(() => processQueue(false), 400);
      } else if (st.state === 'error') {
        n.e = st.message || 'The transcript could not be fetched.';
        saveNotes();
        updateNoteIfOpen(n);
        if (current === 'home') renderHome();
        toast(n.e);
        const permanent = ['nokey', 'auth', 'blocked', 'empty', 'missing']
          .indexOf(st.error) >= 0;
        if (!permanent) {
          setTimeout(() => {
            if (cloud.online && !cloud.busy) processQueue(false);
          }, 45000);
        }
      }
    }, 600);
    cloud.timeout = setTimeout(() => {
      if (!cloud.busy) return;
      stopCloudPoll();
      try { window.Android.cancelCloudTranscribe(); } catch (e) {}
    }, 12 * 60 * 1000);
    return true;
  }

  function processQueue(manual, onlyId) {
    if (!NATIVE) {
      if (manual) toast('Cloud transcription works inside the Android app.');
      return;
    }
    if (cloud.busy) {
      if (manual) toast('Another note is still being transcribed.');
      return;
    }
    refreshCloud(false);
    const waiting = notes
      .filter(n => n.p && (n.pf || n.f))
      .sort((a, b) => a.t - b.t);
    if (!waiting.length) {
      if (manual) toast('Everything is transcribed.');
      return;
    }
    const n = onlyId !== undefined
      ? waiting.find(x => x.id === onlyId)
      : waiting[0];
    if (!n) {
      if (manual) toast('This note is already transcribed.');
      return;
    }
    if (!cloud.configured) {
      if (manual) toast('Add a free Gemini key in Settings first.');
      return;
    }
    if (!cloud.online) {
      if (manual) toast('No internet yet. The note is saved and will wait.');
      return;
    }
    delete n.e;
    saveNotes();
    startCloudNote(n);
  }

  window.appNetwork = function (state) {
    if (state && typeof state.online !== 'undefined') {
      cloud.online = !!state.online;
    } else {
      try { cloud.online = !!window.Android.isOnline(); } catch (e) {}
    }
    paintCloudRow();
    if (cloud.online) processQueue(false);
  };

  let lang = storeGet(LANG_KEY);
  if (!LANGS[lang]) lang = 'bn';

  /* ---------- environment ---------- */
  let reduceMotion = false;
  try { reduceMotion = matchMedia('(prefers-reduced-motion: reduce)').matches; } catch (e) {}
  if (NATIVE) {
    document.documentElement.classList.add('native');
    try { if (window.Android.isReduceMotion && window.Android.isReduceMotion()) reduceMotion = true; } catch (e) {}
  }
  if (reduceMotion) document.documentElement.classList.add('reduce-motion');

  function vibrate(ms) {
    try { if (window.Android && window.Android.vibrate) { window.Android.vibrate(ms); return; } } catch (e) {}
    try { if (navigator.vibrate) navigator.vibrate(ms); } catch (e) {}
  }

  /* ---------- chips ---------- */
  function chipGroup(el, list, onPick) {
    el.innerHTML = '';
    list.forEach(c => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'cat press';
      b.dataset.cat = c;
      b.textContent = c;
      b.setAttribute('aria-pressed', 'false');
      el.appendChild(b);
    });
    el.addEventListener('click', e => {
      const b = e.target.closest('.cat');
      if (b && el.contains(b)) onPick(b.dataset.cat);
    });
    return {
      set(sel) {
        $$('.cat', el).forEach(b => b.setAttribute('aria-pressed', String(b.dataset.cat === sel)));
      }
    };
  }

  /* ---------- language ---------- */
  const segLang = $('#segLang');
  ['bn', 'en', 'auto'].forEach(l => {
    const b = document.createElement('button');
    b.type = 'button';
    b.dataset.lang = l;
    b.textContent = LANGS[l];
    b.setAttribute('aria-pressed', 'false');
    segLang.appendChild(b);
  });

  function syncLangUI() {
    $('#lg').textContent = LANGS[lang];
    $$('button', segLang).forEach(b => b.setAttribute('aria-pressed', String(b.dataset.lang === lang)));
    $('#fab').setAttribute('aria-label',
      'Record a voice note. Voice language: ' + LANGS[lang]
      + '. Swipe up to type. Swipe sideways to change language.');
  }

  function setLang(l, announce) {
    if (!LANGS[l]) return;
    lang = l;
    storeSet(LANG_KEY, l);
    syncLangUI();
    if (announce) {
      toast('Voice language: ' + LANGS[l]);
      vibrate(12);
    }
  }
  syncLangUI();

  /* ---------- screen stack ---------- */
  const SCREENS = {
    splash: $('#splash'),
    home: $('#home'),
    detail: $('#detail'),
    settings: $('#settings')
  };
  let current = 'splash';
  let animating = false;

  function go(id, dir = 'forward') {
    if (!SCREENS[id] || id === current || animating) return;
    const oldEl = SCREENS[current];
    const newEl = SCREENS[id];
    current = id;
    if (reduceMotion || !newEl.animate) {
      oldEl.classList.remove('on');
      newEl.classList.add('on');
      return;
    }
    animating = true;
    newEl.classList.add('on');
    newEl.style.zIndex = '2';
    oldEl.style.zIndex = '1';
    const inX = dir === 'back' ? -32 : 32;
    const outX = dir === 'back' ? 28 : -28;
    const a = newEl.animate(
      [{ transform: 'translateX(' + inX + 'px)', opacity: 0 }, { transform: 'none', opacity: 1 }],
      { duration: 420, easing: 'cubic-bezier(.22,1,.36,1)', fill: 'both' }
    );
    const b = oldEl.animate(
      [{ transform: 'none', opacity: 1 }, { transform: 'translateX(' + outX + 'px)', opacity: 0 }],
      { duration: 360, easing: 'cubic-bezier(.22,1,.36,1)', fill: 'both' }
    );
    let finished = false;
    const done = () => {
      if (finished) return;
      finished = true;
      oldEl.classList.remove('on');
      oldEl.style.zIndex = '';
      newEl.style.zIndex = '';
      try { a.cancel(); b.cancel(); } catch (e) {}
      animating = false;
    };
    Promise.all([a.finished, b.finished]).then(done).catch(done);
  }

  /* ---------- home ---------- */
  let flt = 'All';
  let homeDirty = false;
  let introPlayed = false;
  const listEl = $('#list');
  const homeChips = chipGroup($('#fl'), ['All'].concat(CATS), c => {
    flt = c;
    renderHome();
  });

  function buildRow(n) {
    const row = document.createElement('button');
    row.type = 'button';
    row.className = 'row press';
    row.dataset.id = String(n.id);

    const b = document.createElement('b');
    b.textContent = titleOf(n.x);
    row.appendChild(b);

    const p = document.createElement('p');
    p.textContent = n.p
      ? (n.e || 'Waiting for internet to transcribe…')
      : (n.x || 'No transcript — tap to play the recording.');
    row.appendChild(p);

    const meta = document.createElement('span');
    meta.className = 'meta';
    meta.innerHTML = '<svg class="i s" aria-hidden="true"><use href="#i-mic"/></svg>';
    const dur = document.createElement('span');
    dur.textContent = fmt(n.d);
    meta.appendChild(dur);
    const dot = document.createElement('span');
    dot.textContent = '·';
    meta.appendChild(dot);
    const time = document.createElement('span');
    time.textContent = stamp(n.t);
    meta.appendChild(time);
    const tag = document.createElement('span');
    tag.className = 'tag';
    tag.textContent = n.c;
    meta.appendChild(tag);
    row.appendChild(meta);
    return row;
  }

  function renderHome(highlightId) {
    notes.sort((a, b) => b.t - a.t);
    const count = notes.length;
    const waiting = pendingCount();
    $('#sub').textContent = count
      ? count + (count === 1 ? ' note' : ' notes') + ' · ' + storageLabel()
        + ' on this device' + (waiting ? ' · ' + waiting + ' waiting' : '')
      : '';
    $('#empty').hidden = count > 0;
    $('#fl').hidden = count === 0;
    if (count === 0) flt = 'All';

    const shown = flt === 'All' ? notes : notes.filter(n => n.c === flt);
    listEl.innerHTML = '';
    if (count > 0 && shown.length === 0) {
      const p = document.createElement('p');
      p.className = 'filter-empty';
      p.textContent = 'No ' + flt.toLowerCase() + ' notes yet.';
      listEl.appendChild(p);
    } else {
      let group = '';
      shown.forEach(n => {
        const g = isToday(n.t) ? 'Today' : 'Earlier';
        if (g !== group) {
          const h = document.createElement('div');
          h.className = 'grp';
          h.textContent = g;
          listEl.appendChild(h);
          group = g;
        }
        listEl.appendChild(buildRow(n));
      });
    }
    homeChips.set(flt);
    listEl.scrollTop = 0;

    if (highlightId) {
      setTimeout(() => {
        const row = listEl.querySelector('.row[data-id="' + highlightId + '"]');
        if (row) row.classList.add('fresh');
      }, reduceMotion ? 20 : 420);
    }
  }

  listEl.addEventListener('click', e => {
    const row = e.target.closest('.row');
    if (row) openNote(Number(row.dataset.id));
  });

  function enterHome() {
    if (current !== 'splash') return;
    clearTimeout(splashTimer);
    renderHome();
    go('home', 'forward');
    if (!introPlayed) {
      introPlayed = true;
      setTimeout(() => $('#home').classList.add('intro'), reduceMotion ? 0 : 90);
    }
  }

  /* ---------- mic language swipe + swipe up to type ---------- */
  const fab = $('#fab');
  let sx = null, sy = null, suppressClick = false;

  function swipeLang(dir) {
    if (dir > 0) setLang(lang === 'en' ? 'bn' : 'auto', true);
    else setLang('en', true);
  }

  fab.addEventListener('pointerdown', e => {
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    sx = e.clientX;
    sy = e.clientY;
    suppressClick = false;
    fab.classList.add('drag');
    try { fab.setPointerCapture(e.pointerId); } catch (err) {}
  });

  fab.addEventListener('pointermove', e => {
    if (sx === null) return;
    const dx = e.clientX - sx;
    const dy = e.clientY - sy;
    if (dy < 0 && Math.abs(dy) > Math.abs(dx)) {
      const lift = Math.max(-22, dy * 0.22);
      fab.style.transform = 'translateY(' + lift + 'px)';
    } else {
      const shift = Math.max(-24, Math.min(24, dx * 0.45));
      fab.style.transform = 'translateX(' + shift + 'px)';
    }
  });

  function endSwipe(e) {
    if (sx === null) return;
    const dx = e.clientX - sx;
    const dy = e.clientY - sy;
    sx = null;
    sy = null;
    fab.classList.remove('drag');
    fab.style.transform = '';
    if (dy <= -52 && Math.abs(dx) < 70) {
      suppressClick = true;
      setTimeout(() => { suppressClick = false; }, 450);
      openType();
    } else if (Math.abs(dx) >= 40) {
      suppressClick = true;
      swipeLang(dx > 0 ? 1 : -1);
      setTimeout(() => { suppressClick = false; }, 400);
    }
  }
  fab.addEventListener('pointerup', endSwipe);
  fab.addEventListener('pointercancel', () => {
    if (sx === null) return;
    sx = null;
    sy = null;
    fab.classList.remove('drag');
    fab.style.transform = '';
  });

  fab.addEventListener('click', () => {
    if (suppressClick) { suppressClick = false; return; }
    requestRecording(null);
  });

  /* =========================================================
     TYPE MODE — swipe up on the mic to write by hand
     ========================================================= */
  const typeEl = $('#type');
  const tArea = $('#tArea');
  let typeCat = 'Quick';
  const typeChips = chipGroup($('#tcats'), CATS, c => {
    typeCat = c;
  });

  function openType() {
    if (rec.active || rec.stopping || current !== 'home') return;
    typeCat = flt === 'All' ? 'Quick' : flt;
    typeChips.set(typeCat);
    tArea.value = '';
    tArea.classList.remove('bn');
    typeEl.classList.add('on');
    typeEl.setAttribute('aria-hidden', 'false');
    setTimeout(() => {
      try { tArea.focus(); } catch (e) {}
    }, reduceMotion ? 40 : 430);
  }

  function closeType() {
    typeEl.classList.remove('on');
    typeEl.setAttribute('aria-hidden', 'true');
    try { tArea.blur(); } catch (e) {}
  }

  tArea.addEventListener('input', () => {
    tArea.classList.toggle('bn', hasBn(tArea.value));
  });

  $('#tclose').addEventListener('click', closeType);

  $('#tsave').addEventListener('click', () => {
    const text = tArea.value.replace(/[ \t]+\n/g, '\n').trim();
    if (!text) {
      toast('Write something first.');
      return;
    }
    const n = {
      id: nextId++,
      c: typeCat,
      t: Date.now(),
      d: 0,
      x: text,
      f: ''
    };
    notes.push(n);
    saveNotes();
    bumpUsage();
    updateStorage();
    closeType();
    renderHome(n.id);
    vibrate(10);
    toast('Note saved');
  });

  /* =========================================================
     RECORDING — real microphone, real Whisper transcription
     ========================================================= */
  const recEl = $('#rec');
  const liveEl = $('#live');
  const wvEl = $('#wv');
  wvEl.innerHTML = '<i></i>'.repeat(36);

  const recChips = chipGroup($('#rcats'), CATS, c => { rec.cat = c; recChips.set(c); });

  const rec = {
    active: false,
    paused: false,
    stopping: false,
    awaiting: false,
    appendId: null,
    appendFile: null,
    cat: 'Quick',
    lang: 'bn',
    file: null,
    ms: 0,
    timer: null,
    levels: [],
    waitingPermission: false,
    pendingAppend: null
  };

  function paintWave() {
    const bars = wvEl.children;
    for (let i = 0; i < bars.length; i++) {
      bars[i].style.transform = 'scaleY(' + Math.max(0.06, rec.levels[i] || 0.06).toFixed(2) + ')';
    }
  }

  function setLivePlaceholder() {
    liveEl.innerHTML = '';
    const ph = document.createElement('span');
    ph.className = 'ph';
    if (rec.paused) {
      ph.textContent = 'Paused';
    } else if (rec.lang === 'bn') {
      ph.textContent = 'বলুন… থামালে লেখা আসবে।';
    } else {
      ph.textContent = 'Speak now… your words appear when you stop.';
    }
    liveEl.appendChild(ph);
    liveEl.classList.toggle('bn', rec.lang === 'bn');
  }

  function paintRecTime() {
    $('#rt').textContent = fmt(rec.ms / 1000);
  }

  function syncPauseUI() {
    $('#rpi').setAttribute('href', rec.paused ? '#i-mic' : '#i-pause');
    $('#rp').setAttribute('aria-label', rec.paused ? 'Resume' : 'Pause');
    const st = $('#rs');
    if (rec.stopping) {
      st.textContent = 'Finishing…';
      st.className = 'st';
    } else if (rec.paused) {
      st.textContent = 'Paused';
      st.className = 'st';
    } else {
      st.textContent = 'Listening…';
      st.className = 'st rec';
    }
    setLivePlaceholder();
  }

  function startRecTimer() {
    stopRecTimer();
    rec.timer = setInterval(() => {
      if (!rec.active || rec.stopping) return;
      let state = null;
      try { state = nativeJson(window.Android.recorderState()); } catch (e) {}
      if (!state) return;
      if (typeof state.ms === 'number') rec.ms = state.ms;
      if (typeof state.paused === 'boolean' && state.paused !== rec.paused) {
        rec.paused = state.paused;
        syncPauseUI();
      }
      if (!state.active && !rec.paused) {
        // The microphone stopped outside this screen.
        stopRecTimer();
        rec.active = false;
        resetRecUI();
        hideRecSheet();
        toast('Recording stopped unexpectedly.');
        return;
      }
      const level = Number(state.level) || 0;
      const next = rec.paused ? 0.06 : Math.max(0.06, Math.min(1, level * 1.15));
      rec.levels.push(next);
      if (rec.levels.length > 36) rec.levels.shift();
      paintWave();
      paintRecTime();
    }, 120);
  }

  function stopRecTimer() {
    clearInterval(rec.timer);
    rec.timer = null;
  }

  function resetRecUI() {
    rec.paused = false;
    rec.stopping = false;
    rec.awaiting = false;
    rec.appendId = null;
    rec.appendFile = null;
    rec.file = null;
    rec.ms = 0;
    rec.levels = Array(36).fill(0.06);
    syncPauseUI();
    paintRecTime();
    paintWave();
    $('#done').classList.remove('on', 'ok');
    $('#rpi').setAttribute('href', '#i-pause');
    $('#rp').setAttribute('aria-label', 'Pause');
  }

  function showRecSheet() {
    recEl.classList.add('on');
    recEl.setAttribute('aria-hidden', 'false');
  }

  function hideRecSheet() {
    recEl.classList.remove('on');
    recEl.setAttribute('aria-hidden', 'true');
    closeDialog();
  }

  function requestRecording(appendId) {
    if (rec.active || rec.stopping || rec.awaiting) return;
    if (!NATIVE) {
      toast('Recording works inside the Android app.');
      return;
    }
    if (rec.waitingPermission) return;
    const target = appendId !== null && noteById(appendId);
    if (appendId !== null && !target) return;

    rec.appendId = target ? target.id : null;
    rec.appendFile = target ? target.f : null;
    rec.cat = target ? target.c : (flt === 'All' ? 'Quick' : flt);
    rec.lang = lang;

    let allowed = false;
    try { allowed = !!window.Android.hasMicPermission(); } catch (e) {}
    if (!allowed) {
      rec.waitingPermission = true;
      rec.pendingAppend = rec.appendId;
      try { window.Android.requestMicPermission(); } catch (e) {}
      toast('Allow microphone access to record.');
      return;
    }
    startNativeRecording();
  }

  function startNativeRecording() {
    let result = null;
    try { result = nativeJson(window.Android.startRecording(rec.lang)); } catch (e) {}
    if (!result || !result.ok) {
      const error = result && result.error;
      resetRecUI();
      if (error === 'permission') {
        rec.waitingPermission = true;
        rec.pendingAppend = rec.appendId;
        try { window.Android.requestMicPermission(); } catch (e) {}
        toast('Microphone permission is needed to record.');
      } else if (error === 'busy') {
        toast('The microphone is already in use.');
      } else if (error === 'storage') {
        toast('There is not enough free space to record.');
      } else {
        toast((result && result.message) || 'The microphone could not start.');
      }
      return;
    }

    rec.active = true;
    rec.stopping = false;
    rec.awaiting = false;
    rec.paused = false;
    rec.file = result.file;
    rec.ms = 0;
    rec.levels = Array(36).fill(0.06);

    $('#recBadge').textContent = 'On this phone · ' + LANGS[rec.lang];
    $('#rcats').hidden = rec.appendId !== null;
    recChips.set(rec.cat);
    paintRecTime();
    paintWave();
    syncPauseUI();
    $('#done').classList.remove('on', 'ok');
    $('#dmsg').textContent = 'Saving the recording…';
    showRecSheet();
    startRecTimer();
  }

  function togglePause() {
    if (!rec.active || rec.stopping) return;
    const wantPause = !rec.paused;
    let ok = false;
    try { ok = window.Android.pauseRecording(wantPause); } catch (e) {}
    if (!ok) {
      toast('The recording could not be paused.');
      return;
    }
    rec.paused = wantPause;
    if (rec.paused) {
      rec.levels = Array(36).fill(0.06);
      paintWave();
    }
    syncPauseUI();
    vibrate(8);
  }

  function showDone(text, ok) {
    $('#done').classList.toggle('ok', !!ok);
    $('#dmsg').textContent = text;
    $('#done').classList.add('on');
  }

  function stopRec() {
    if (!rec.active || rec.stopping) return;
    stopRecTimer();

    if (rec.ms < 500) {
      try { window.Android.cancelRecording(); } catch (e) {}
      rec.active = false;
      const msg = 'That was too short. Hold on a little longer.';
      resetRecUI();
      hideRecSheet();
      toast(msg);
      return;
    }

    rec.stopping = true;
    syncPauseUI();
    showDone('Saving the recording…', false);

    const appendId = rec.appendId;
    let result = null;
    try { result = nativeJson(window.Android.stopRecording(rec.appendFile)); } catch (e) {}
    if (!result || !result.ok) {
      rec.active = false;
      rec.stopping = false;
      resetRecUI();
      hideRecSheet();
      const error = result && result.error;
      if (error === 'too_short') toast('That was too short. Hold on a little longer.');
      else if (error === 'not_recording') toast('The recording had already stopped.');
      else toast('The recording could not be saved.');
      return;
    }
    rec.active = false;
    refreshCloud(false);

    const duration = Math.max(1, Math.round((Number(result.durationMs) || 0) / 1000));
    let n = appendId !== null ? noteById(appendId) : null;
    if (n && n.f) {
      // Keep the old audio until the new part has a transcript; then the two
      // WAV files are joined so the player still has one recording.
      n.pf = result.file;
      n.pl = rec.lang;
      n.p = 1;
      delete n.e;
    } else if (n) {
      n.f = result.file;
      n.d = duration;
      n.pl = rec.lang;
      n.p = 1;
      delete n.e;
    } else {
      n = {
        id: nextId++,
        c: rec.cat,
        t: Date.now(),
        d: duration,
        x: '',
        f: result.file,
        p: 1,
        l: rec.lang
      };
      notes.push(n);
    }
    saveNotes();
    bumpUsage();
    updateStorage();

    const wasDetail = current === 'detail';
    showDone(cloud.configured ? 'Saved · transcript follows' : 'Saved · add a cloud key', true);
    vibrate(10);
    setTimeout(() => {
      hideRecSheet();
      resetRecUI();
      if (wasDetail) openNote(n.id, true);
      else renderHome(n.id);
      if (!cloud.configured) {
        toast('Saved. Add a free Gemini key in Settings to transcribe.');
      } else if (!cloud.online) {
        toast('Saved. It will transcribe when the internet comes back.');
      }
      processQueue(false);
    }, 900);
  }

  function requestRecClose() {
    if (rec.stopping || rec.awaiting) return;
    if (!rec.active) {
      hideRecSheet();
      resetRecUI();
      return;
    }
    if (rec.ms >= 800) {
      openDialog();
    } else {
      discardRecording();
    }
  }

  function discardRecording() {
    stopRecTimer();
    try { window.Android.cancelRecording(); } catch (e) {}
    rec.active = false;
    const hadAudio = rec.ms >= 500;
    resetRecUI();
    hideRecSheet();
    if (hadAudio) toast('Recording discarded');
  }

  function saveAudioOnly(res) {
    if (rec.appendId !== null) {
      const msg = 'The words could not be transcribed. The earlier note was not changed.';
      finishTranscriptionWithMessage(msg);
      return;
    }
    if (!res.file) {
      finishTranscriptionWithMessage('The recording could not be transcribed.');
      return;
    }
    const n = {
      id: nextId++,
      c: rec.cat,
      t: Date.now(),
      d: Math.max(1, Math.round((Number(res.durationMs) || 0) / 1000)),
      x: '',
      f: res.file
    };
    notes.push(n);
    saveNotes();
    bumpUsage();
    updateStorage();
    showDone('Recording saved without a transcript', true);
    vibrate(10);
    setTimeout(() => {
      const wasDetail = current === 'detail';
      hideRecSheet();
      resetRecUI();
      homeDirty = false;
      if (wasDetail) { curNoteId = null; go('home', 'back'); }
      renderHome(n.id);
      toast('Recording saved. No transcript was created.');
    }, 850);
  }

  function finishTranscriptionWithMessage(message) {
    showDone(message, false);
    setTimeout(() => {
      hideRecSheet();
      resetRecUI();
      toast(message);
    }, 1600);
  }

  function onTranscriptionDone(res) {
    if (!rec.awaiting) return;
    rec.awaiting = false;
    rec.stopping = false;

    if (!res || !res.ok) {
      if (res && res.error === 'transcription' && res.file) {
        saveAudioOnly(res);
        return;
      }
      if (res && res.error === 'no_speech' && res.file) {
        saveAudioOnly(res);
        return;
      }
      const msg = res && res.error === 'no_speech'
        ? 'No speech was recognised. Try again.'
        : (res && res.message) || 'The recording could not be transcribed.';
      finishTranscriptionWithMessage(msg);
      return;
    }

    const duration = Math.max(1, Math.round((Number(res.durationMs) || 0) / 1000));

    if (rec.appendId !== null) {
      const n = noteById(rec.appendId);
      if (!n) {
        finishTranscriptionWithMessage('The note was not found. Your recording was kept.');
        return;
      }
      const text = (res.text || '').trim();
      n.x = (n.x ? n.x + '\n\n' : '') + text;
      n.f = res.file || n.f;
      n.d = duration;
      saveNotes();
      bumpUsage();
      updateStorage();
      homeDirty = true;
      showDone('Added to note', true);
      vibrate(10);
      setTimeout(() => {
        hideRecSheet();
        resetRecUI();
        if (current === 'detail' && curNoteId === n.id) openNote(n.id, true);
        renderHome();
        toast('Added to the note');
      }, 750);
      return;
    }

    const n = {
      id: nextId++,
      c: rec.cat,
      t: Date.now(),
      d: duration,
      x: (res.text || '').trim(),
      f: res.file
    };
    notes.push(n);
    saveNotes();
    bumpUsage();
    updateStorage();
    homeDirty = false;
    showDone('Saved on this phone', true);
    vibrate(12);
    setTimeout(() => {
      const wasDetail = current === 'detail';
      hideRecSheet();
      resetRecUI();
      if (wasDetail) { curNoteId = null; go('home', 'back'); }
      renderHome(n.id);
    }, 850);
  }

  /* ---------- discard dialog ---------- */
  const dlg = $('#dlg');
  function openDialog() {
    dlg.classList.add('on');
    dlg.setAttribute('aria-hidden', 'false');
  }
  function closeDialog() {
    dlg.classList.remove('on');
    dlg.setAttribute('aria-hidden', 'true');
  }
  dlg.addEventListener('click', e => { if (e.target === dlg) closeDialog(); });
  $('#keep').addEventListener('click', closeDialog);
  $('#drop').addEventListener('click', () => {
    closeDialog();
    discardRecording();
  });

  /* ---------- recording controls ---------- */
  $('#rp').addEventListener('click', togglePause);
  $('#rstop').addEventListener('click', stopRec);
  $('#rx').addEventListener('click', requestRecClose);

  /* =========================================================
     NOTE DETAIL + REAL AUDIO PLAYER
     ========================================================= */
  const dB = $('#dB');
  let curNoteId = null;
  const NB = 44;

  const pb = {
    noteId: null,
    durMs: 0,
    posMs: 0,
    speed: 1,
    playing: false,
    timer: null,
    seeking: false,
    missing: false
  };

  const detailChips = chipGroup($('#dC'), CATS, c => moveCurrentTo(c));

  function buildBars(seed) {
    const frag = document.createDocumentFragment();
    for (let i = 0; i < NB; i++) {
      const el = document.createElement('i');
      const r = Math.abs(Math.sin((seed + 1) * 12.9898 + i * 78.233) * 43758.5453) % 1;
      el.style.height = (8 + Math.round(r * 32)) + 'px';
      frag.appendChild(el);
    }
    dB.innerHTML = '';
    dB.appendChild(frag);
  }

  function setPlayIcon(on) {
    $('#ppi').setAttribute('href', on ? '#i-pause' : '#i-play');
    $('#pp').setAttribute('aria-label', on ? 'Pause' : 'Play recording');
  }

  function paintPlayer() {
    const n = noteById(curNoteId);
    if (!n) return;
    const dur = pb.durMs > 0 ? pb.durMs : Math.max(1, n.d * 1000);
    const ratio = Math.max(0, Math.min(1, pb.posMs / dur));
    $$('#dB i').forEach((el, i) => el.classList.toggle('on', i < ratio * NB));
    $('#cT').textContent = fmt(pb.posMs / 1000);
    $('#dD').textContent = fmt(dur / 1000);
    dB.setAttribute('aria-valuemax', String(Math.round(dur / 1000)));
    dB.setAttribute('aria-valuenow', String(Math.floor(pb.posMs / 1000)));
    dB.setAttribute('aria-valuetext', fmt(pb.posMs / 1000) + ' of ' + fmt(dur / 1000));
  }

  function stopPlayerTicker() {
    clearInterval(pb.timer);
    pb.timer = null;
  }

  function startPlayerTicker() {
    stopPlayerTicker();
    pb.timer = setInterval(() => {
      let state = null;
      try { state = nativeJson(window.Android.playerState()); } catch (e) {}
      if (!state) return;
      if (state.prepared) {
        if (Number(state.durationMs) > 0) pb.durMs = Number(state.durationMs);
        if (!pb.seeking) pb.posMs = Math.max(0, Number(state.positionMs) || 0);
        if (pb.playing && !state.playing) {
          pb.playing = false;
          setPlayIcon(false);
          stopPlayerTicker();
        }
        paintPlayer();
      }
    }, 150);
  }

  function releasePlayback() {
    stopPlayerTicker();
    pb.playing = false;
    pb.posMs = 0;
    pb.missing = false;
    setPlayIcon(false);
    if (NATIVE) {
      try { window.Android.stopAudio(); } catch (e) {}
    }
  }

  function openNote(id, updateOnly) {
    const n = noteById(id);
    if (!n) return;
    curNoteId = id;
    releasePlayback();
    pb.noteId = id;
    pb.durMs = Math.max(1, n.d * 1000);
    pb.posMs = 0;
    pb.speed = 1;
    pb.missing = false;
    $('#spd').textContent = '1×';
    $('#dT').textContent = titleOf(n.x);
    const metaParts = [stamp(n.t)];
    if (n.d > 0) metaParts.push(fmt(n.d));
    $('#dM').textContent = metaParts.join(' · ');
    const hasAudio = !!n.f;
    $('#player').hidden = !hasAudio;
    if (n.p) {
      $('#dX').textContent = n.e
        ? 'Waiting for the internet.\n\n' + n.e
        : 'Waiting for the internet to transcribe this recording. '
          + 'It will finish automatically on Wi-Fi or mobile data.';
    } else if (n.x) {
      $('#dX').textContent = n.x;
    } else {
      $('#dX').textContent = hasAudio
        ? 'No transcript for this note. The recording is still saved.'
        : 'No text yet.';
    }
    $('#dX').classList.toggle('bn', hasBn(n.x));
    $('#dTr').hidden = !n.p;
    $('#dTr').textContent = !cloud.configured
      ? 'Set up cloud transcription'
      : (cloud.online ? 'Transcribe now' : 'Waiting for internet');
    $('#dTr').disabled = cloud.configured && !cloud.online;
    $('#dD').textContent = fmt(n.d);
    $('#cT').textContent = '0:00';
    detailChips.set(n.c);
    buildBars(n.id);
    setPlayIcon(false);

    if (NATIVE) {
      let info = null;
      try { info = nativeJson(window.Android.audioInfo(n.f)); } catch (e) {}
      if (info && info.exists) {
        if (Number(info.durationMs) > 0) pb.durMs = Number(info.durationMs);
        pb.missing = false;
      } else {
        pb.missing = true;
      }
    }
    if (NATIVE) {
      try { window.Android.setSpeed(1); } catch (e) {}
    }
    paintPlayer();

    if (!updateOnly) {
      $('#detailBody').scrollTop = 0;
      go('detail', 'forward');
    }
  }

  function moveCurrentTo(c) {
    const n = noteById(curNoteId);
    if (!n || n.c === c) return;
    n.c = c;
    saveNotes();
    homeDirty = true;
    detailChips.set(c);
    toast('Moved to ' + c);
  }

  function closeDetail() {
    releasePlayback();
    curNoteId = null;
    if (homeDirty) {
      renderHome();
      homeDirty = false;
    }
    go('home', 'back');
  }

  function togglePlay() {
    const n = noteById(curNoteId);
    if (!n) return;
    if (!NATIVE) {
      toast('Playback works inside the Android app.');
      return;
    }
    if (pb.missing) {
      toast('This recording is missing from this phone.');
      return;
    }
    if (pb.playing) {
      try { window.Android.pauseAudio(); } catch (e) {}
      pb.playing = false;
      setPlayIcon(false);
      stopPlayerTicker();
      paintPlayer();
      return;
    }
    if (pb.posMs >= pb.durMs - 100) {
      pb.posMs = 0;
      try { window.Android.seekAudio(0); } catch (e) {}
    }
    pb.playing = true;
    setPlayIcon(true);
    try { window.Android.playAudio(n.f); } catch (e) {}
    startPlayerTicker();
    paintPlayer();
  }

  function seekRatio(clientX) {
    const r = dB.getBoundingClientRect();
    const ratio = Math.max(0, Math.min(1, (clientX - r.left) / Math.max(1, r.width)));
    pb.posMs = ratio * (pb.durMs > 0 ? pb.durMs : 1);
    paintPlayer();
  }

  dB.addEventListener('pointerdown', e => {
    if (!curNoteId) return;
    pb.seeking = true;
    try { dB.setPointerCapture(e.pointerId); } catch (err) {}
    seekRatio(e.clientX);
    e.preventDefault();
  });
  dB.addEventListener('pointermove', e => {
    if (!pb.seeking) return;
    seekRatio(e.clientX);
    e.preventDefault();
  });
  ['pointerup', 'pointercancel'].forEach(ev => dB.addEventListener(ev, () => {
    if (!pb.seeking) return;
    pb.seeking = false;
    if (NATIVE) {
      try { window.Android.seekAudio(Math.round(pb.posMs)); } catch (e) {}
    }
  }));
  dB.addEventListener('keydown', e => {
    const n = noteById(curNoteId);
    if (!n) return;
    const step = 5000;
    if (e.key === 'ArrowRight') {
      pb.posMs = Math.min(pb.durMs, pb.posMs + step);
    } else if (e.key === 'ArrowLeft') {
      pb.posMs = Math.max(0, pb.posMs - step);
    } else {
      return;
    }
    if (NATIVE) {
      try { window.Android.seekAudio(Math.round(pb.posMs)); } catch (err) {}
    }
    paintPlayer();
    e.preventDefault();
  });

  $('#pp').addEventListener('click', togglePlay);

  $('#spd').addEventListener('click', () => {
    pb.speed = pb.speed === 1 ? 1.5 : pb.speed === 1.5 ? 2 : 1;
    $('#spd').textContent = pb.speed + '×';
    if (NATIVE) {
      try { window.Android.setSpeed(pb.speed); } catch (e) {}
    }
  });

  function copyText(text) {
    try {
      if (window.Android && window.Android.copy) { window.Android.copy(text); return true; }
    } catch (e) {}
    try {
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(text).catch(() => {});
        return true;
      }
    } catch (e) {}
    return false;
  }

  $('#cpy').addEventListener('click', () => {
    const n = noteById(curNoteId);
    if (!n) return;
    if (!n.x) { toast('This note has no transcript.'); return; }
    if (copyText(n.x)) toast('Copied to clipboard');
    else toast('Copy is not available here.');
  });

  $('#shr').addEventListener('click', () => {
    const n = noteById(curNoteId);
    if (!n) return;
    if (!n.x) { toast('This note has no transcript to share.'); return; }
    try {
      if (window.Android && window.Android.share) { window.Android.share(n.x); return; }
    } catch (e) {}
    if (navigator.share) {
      navigator.share({ text: n.x }).catch(() => {});
      return;
    }
    toast('Sharing is not available here.');
  });

  /* ---------- audio cleanup ---------- */
  let pruneTimer = null;

  function pruneUnusedAudio(delay) {
    clearTimeout(pruneTimer);
    pruneTimer = setTimeout(() => {
      pruneTimer = null;
      if (!NATIVE) return;
      const names = [];
      notes.forEach(n => {
        if (n.f) names.push(n.f);
        if (n.pf) names.push(n.pf);
      });
      try { window.Android.pruneAudio(JSON.stringify(names)); } catch (e) {}
      updateStorage();
    }, typeof delay === 'number' ? delay : 6500);
  }

  function cancelScheduledPrune() {
    clearTimeout(pruneTimer);
    pruneTimer = null;
  }

  $('#del').addEventListener('click', () => {
    if (curNoteId === null) return;
    const idx = notes.findIndex(n => n.id === curNoteId);
    if (idx < 0) return;
    const removed = notes[idx];
    releasePlayback();
    notes.splice(idx, 1);
    saveNotes();
    updateStorage();
    curNoteId = null;
    homeDirty = false;
    renderHome();
    go('home', 'back');
    pruneUnusedAudio();
    toast('Note deleted', () => {
      cancelScheduledPrune();
      notes.splice(Math.min(idx, notes.length), 0, removed);
      saveNotes();
      updateStorage();
      homeDirty = false;
      renderHome(removed.id);
    }, 'Undo');
  });

  $('#more').addEventListener('click', () => {
    if (curNoteId === null) return;
    const n = noteById(curNoteId);
    if (n && n.p) {
      toast('Wait for this note to be transcribed first.');
      return;
    }
    releasePlayback();
    requestRecording(curNoteId);
  });

  $('#dTr').addEventListener('click', () => {
    if (curNoteId === null) return;
    if (!cloud.configured) {
      go('settings', 'forward');
      setTimeout(openCloudDialog, 480);
      return;
    }
    processQueue(true, curNoteId);
  });

  $('#backDetail').addEventListener('click', closeDetail);

  /* =========================================================
     SETTINGS + EXPORT
     ========================================================= */
  function storageLabel() {
    let bytes = 0;
    if (NATIVE) {
      try { bytes = Number(window.Android.storageBytes()) || 0; } catch (e) {}
    }
    if (bytes <= 0) return '0 MB';
    const mb = bytes / (1024 * 1024);
    return mb < 0.1 ? '<0.1 MB' : mb.toFixed(1) + ' MB';
  }

  function updateStorage() {
    const el = $('#stor');
    if (!el) return;
    const count = notes.length;
    el.textContent = count + (count === 1 ? ' note' : ' notes') + ' · ' + storageLabel();
  }

  /* ---------- last 7 days ---------- */
  function renderUsage() {
    const chart = $('#uChart');
    if (!chart) return;
    const now = new Date();
    const start = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const days = [];
    for (let i = 6; i >= 0; i--) {
      const d = new Date(start.getFullYear(), start.getMonth(), start.getDate() - i);
      days.push({ d, key: dayKey(d.getTime()), today: i === 0 });
    }
    const counts = days.map(x => Number(usage[x.key]) || 0);
    const total = counts.reduce((sum, value) => sum + value, 0);
    const max = Math.max(1, ...counts);
    chart.innerHTML = '';
    days.forEach((day, i) => {
      const count = counts[i];
      const col = document.createElement('div');
      col.className = 'uday' + (count > 0 ? ' has' : '') + (day.today ? ' today' : '');
      const track = document.createElement('div');
      track.className = 'track';
      const fill = document.createElement('i');
      fill.className = 'fill';
      fill.style.height = count > 0
        ? Math.max(14, Math.round(count / max * 100)) + '%'
        : '4px';
      track.appendChild(fill);
      const label = document.createElement('em');
      label.textContent = day.d.toLocaleDateString('en-US', { weekday: 'narrow' });
      const full = day.d.toLocaleDateString('en-US', {
        weekday: 'long', month: 'short', day: 'numeric'
      });
      const text = count + (count === 1 ? ' note' : ' notes');
      col.title = full + ' — ' + text;
      col.setAttribute('role', 'img');
      col.setAttribute('aria-label', full + ', ' + text);
      col.appendChild(track);
      col.appendChild(label);
      chart.appendChild(col);
    });
    const sum = $('#uSum');
    if (sum) sum.textContent = total
      ? total + (total === 1 ? ' note' : ' notes')
      : 'No notes yet';
  }

  /* ---------- name ---------- */
  const nameIn = $('#nameIn');
  const homeTitle = $('#homeTitle');

  function syncNameUI() {
    if (homeTitle) homeTitle.textContent = profileName ? 'Notes of ' + profileName : 'Notes';
    if (nameIn && document.activeElement !== nameIn) nameIn.value = profileName;
  }

  if (nameIn) {
    nameIn.value = profileName;
    nameIn.addEventListener('input', () => {
      // Keep the header live while typing, but store the trimmed value.
      profileName = cleanName(nameIn.value);
      storeSet(PROFILE_KEY, JSON.stringify({ name: profileName }));
      syncNameUI();
    });
    nameIn.addEventListener('blur', () => {
      profileName = cleanName(nameIn.value);
      nameIn.value = profileName;
      storeSet(PROFILE_KEY, JSON.stringify({ name: profileName }));
      syncNameUI();
    });
    nameIn.addEventListener('keydown', e => {
      if (e.key === 'Enter') { e.preventDefault(); nameIn.blur(); }
    });
  }

  /* ---------- cloud transcription settings ---------- */
  const cloudDlg = $('#cloudDlg');
  const cloudKeyIn = $('#cloudKeyIn');
  const cloudModelEl = $('#cloudModel');
  let cloudModelChoice = 'gemini-2.5-flash';

  [['gemini-2.5-flash', 'Fast'], ['gemini-2.5-pro', 'Best quality']].forEach(pair => {
    const b = document.createElement('button');
    b.type = 'button';
    b.dataset.model = pair[0];
    b.textContent = pair[1];
    b.setAttribute('aria-pressed', 'false');
    cloudModelEl.appendChild(b);
  });

  function syncCloudModelUI() {
    $$('button', cloudModelEl).forEach(b => {
      b.setAttribute('aria-pressed', String(b.dataset.model === cloudModelChoice));
    });
  }

  function refreshCloudDialog() {
    refreshCloud();
    cloudModelChoice = cloud.model;
    syncCloudModelUI();
    cloudKeyIn.value = '';
    cloudKeyIn.placeholder = cloud.configured
      ? 'Saved key ' + cloud.masked
      : 'Paste Gemini API key';
    const waiting = pendingCount();
    $('#cloudMsg').textContent = !cloud.configured
      ? 'Recordings stay on this phone until you add a free Gemini key.'
      : !cloud.online
        ? 'Key saved. Transcribing starts when the internet comes back.'
        : waiting
          ? waiting + (waiting === 1 ? ' note is' : ' notes are') + ' waiting to transcribe.'
          : 'Ready. New recordings transcribe after you stop.';
    $('#cloudRemove').hidden = !cloud.configured;
  }

  function openCloudDialog() {
    refreshCloudDialog();
    cloudDlg.classList.add('on');
    cloudDlg.setAttribute('aria-hidden', 'false');
    setTimeout(() => {
      try { cloudKeyIn.focus(); } catch (e) {}
    }, reduceMotion ? 40 : 260);
  }

  function closeCloudDialog() {
    cloudDlg.classList.remove('on');
    cloudDlg.setAttribute('aria-hidden', 'true');
    try { cloudKeyIn.blur(); } catch (e) {}
  }

  $('#cloudRow').addEventListener('click', openCloudDialog);
  $('#cloudClose').addEventListener('click', closeCloudDialog);
  cloudDlg.addEventListener('click', e => {
    if (e.target === cloudDlg) closeCloudDialog();
  });
  cloudModelEl.addEventListener('click', e => {
    const b = e.target.closest('button[data-model]');
    if (!b) return;
    cloudModelChoice = b.dataset.model;
    syncCloudModelUI();
  });
  $('#cloudSave').addEventListener('click', () => {
    if (!NATIVE) {
      toast('Cloud transcription works inside the Android app.');
      return;
    }
    const key = cloudKeyIn.value.trim();
    if (!key && !cloud.configured) {
      $('#cloudMsg').textContent = 'Paste a Gemini key first.';
      return;
    }
    if (key && key.length < 20) {
      $('#cloudMsg').textContent = 'That key looks too short. Copy the whole key.';
      return;
    }
    try { window.Android.saveCloudConfig(key, cloudModelChoice); } catch (e) {}
    refreshCloudDialog();
    toast(key ? 'Gemini key saved' : 'Quality saved');
    if (key) {
      closeCloudDialog();
      setTimeout(() => processQueue(false), 500);
    }
  });
  $('#cloudRemove').addEventListener('click', () => {
    if (!NATIVE) return;
    try { window.Android.clearCloudConfig(); } catch (e) {}
    refreshCloudDialog();
    toast('Gemini key removed');
  });
  $('#cloudGet').addEventListener('click', () => {
    if (!NATIVE) return;
    try { window.Android.openUrl('https://aistudio.google.com/apikey'); } catch (e) {}
  });

  function exportText() {
    const ordered = notes.slice().sort((a, b) => b.t - a.t);
    const head = 'KothaNote — voice notes\nExported ' +
      new Date().toLocaleString('en-US') + '\n\n';
    const body = ordered.map(n => {
      const when = new Date(n.t).toLocaleString('en-US', {
        year: 'numeric', month: 'short', day: 'numeric',
        hour: 'numeric', minute: '2-digit'
      });
      return titleOf(n.x) + '\n' + when + ' · ' + n.c +
        (n.d > 0 ? ' · ' + fmt(n.d) : '') +
        '\n\n' + (n.x || (n.p ? '(waiting for internet transcription)' : '(no transcript)'));
    }).join('\n\n---\n\n');
    return head + body + '\n';
  }

  function exportName() {
    const d = new Date();
    const pad = n => String(n).padStart(2, '0');
    return 'KothaNote-' + d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()) + '.txt';
  }

  $('#exp').addEventListener('click', () => {
    if (!notes.length) {
      toast('No notes to export yet.');
      return;
    }
    const content = exportText();
    const name = exportName();
    if (NATIVE) {
      let ok = false;
      try { ok = window.Android.exportNotes(content, name); } catch (e) {}
      toast(ok ? 'Preparing export…' : 'Export is not available.');
      return;
    }
    try {
      const blob = new Blob([content], { type: 'text/plain;charset=utf-8' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = name;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 2000);
      toast('Exported');
    } catch (e) {
      toast('Export is not available here.');
    }
  });

  function openSettings() {
    updateStorage();
    syncNameUI();
    renderUsage();
    refreshCloud();
    syncLangUI();
    $('#settings .body').scrollTop = 0;
    go('settings', 'forward');
  }

  $('#openSettings').addEventListener('click', openSettings);
  $('#backSettings').addEventListener('click', () => go('home', 'back'));
  segLang.addEventListener('click', e => {
    const b = e.target.closest('button[data-lang]');
    if (b) setLang(b.dataset.lang, false);
  });

  /* =========================================================
     NATIVE CALLBACKS
     ========================================================= */
  let speech = { state: 'idle', ready: false, progress: 0, message: '', error: '' };

  function paintSpeechStatus() {
    const el = $('#modelStatus');
    if (!el) return;
    if (speech.state === 'ready') el.textContent = 'Whisper Tiny · ready';
    else if (speech.state === 'preparing') el.textContent = 'Whisper Tiny · preparing…';
    else if (speech.state === 'transcribing') el.textContent = 'Whisper Tiny · transcribing…';
    else if (speech.state === 'error') el.textContent = 'Whisper Tiny · unavailable';
    else el.textContent = 'Whisper Tiny · on-device';
    el.title = speech.error || speech.message || '';
  }

  window.onSpeechStatus = function (status) {
    if (!status) return;
    speech = status;
    paintSpeechStatus();
    if (rec.awaiting) {
      if (status.state === 'transcribing') {
        const pct = Number(status.progress) || 0;
        $('#dmsg').textContent = pct > 0
          ? 'Listening closely… ' + pct + '%'
          : 'Listening closely…';
      } else if (status.state === 'preparing') {
        $('#dmsg').textContent = 'Getting ready…';
      }
    }
  };

  window.onTranscriptionResult = function (result) {
    onTranscriptionDone(result || {});
  };

  window.onMicPermission = function (granted) {
    const wasWaiting = rec.waitingPermission;
    rec.waitingPermission = false;
    if (!granted) {
      rec.pendingAppend = null;
      if (wasWaiting) toast('Microphone permission is needed to record.');
      return;
    }
    if (wasWaiting) {
      const target = rec.pendingAppend;
      rec.pendingAppend = null;
      requestRecording(target);
    }
  };

  window.onExportResult = function (result) {
    if (!result) {
      toast('Export failed.');
      return;
    }
    if (result.ok) {
      const path = result.path || '';
      const short = path.indexOf('KothaNote/') >= 0 ? 'Downloads/KothaNote' : path;
      toast('Exported to ' + short);
    } else {
      toast(result.error || 'Export failed.');
    }
  };

  window.onPlaybackEnded = function () {
    pb.playing = false;
    pb.posMs = pb.durMs;
    setPlayIcon(false);
    stopPlayerTicker();
    paintPlayer();
  };

  window.onPlaybackError = function (message) {
    pb.playing = false;
    setPlayIcon(false);
    stopPlayerTicker();
    toast(message || 'This recording could not be played.');
  };

  window.onRecordingInterrupted = function () {
    if (!rec.active || rec.stopping) return;
    stopRecTimer();
    rec.active = false;
    resetRecUI();
    hideRecSheet();
    toast('Recording stopped because the app left the foreground.');
  };

  /* =========================================================
     TOAST + HARDWARE BACK + BOOT
     ========================================================= */
  let toastTimer = null;
  let toastAction = null;

  function hideToast() {
    clearTimeout(toastTimer);
    $('#toast').classList.remove('on');
    toastAction = null;
  }

  function toast(msg, action, actionLabel) {
    clearTimeout(toastTimer);
    toastAction = action || null;
    $('#tmsg').textContent = msg;
    const btn = $('#tundo');
    btn.hidden = !action;
    btn.textContent = actionLabel || 'Undo';
    $('#toast').classList.add('on');
    toastTimer = setTimeout(hideToast, 4000);
  }

  $('#tundo').addEventListener('click', () => {
    const fn = toastAction;
    hideToast();
    if (fn) fn();
  });

  window.appBack = function () {
    if (animating) return true;
    if (cloudDlg.classList.contains('on')) { closeCloudDialog(); return true; }
    if (typeEl.classList.contains('on')) { closeType(); return true; }
    if (dlg.classList.contains('on')) { closeDialog(); return true; }
    if (recEl.classList.contains('on')) {
      if (rec.stopping || rec.awaiting) return true;
      requestRecClose();
      return true;
    }
    if (current === 'splash') { enterHome(); return true; }
    if (current === 'detail') { closeDetail(); return true; }
    if (current === 'settings') { go('home', 'back'); return true; }
    return false;
  };

  let splashTimer = null;
  $('#splash').addEventListener('click', enterHome);

  renderHome();
  updateStorage();
  syncNameUI();
  renderUsage();
  refreshCloud();
  if (NATIVE) {
    // Remove recordings that no longer belong to any note. The native side
    // also keeps files younger than ten minutes, so this cannot touch a
    // recording that is still being transcribed.
    setTimeout(() => pruneUnusedAudio(0), 2500);
    // Anything saved without the internet finishes here.
    setTimeout(() => processQueue(false), 1600);
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState !== 'visible') return;
      refreshCloud();
      processQueue(false);
    });
  }

  splashTimer = setTimeout(enterHome, 2400);
})();

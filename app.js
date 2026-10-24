/**
 * LiveCaption — live English speech → text → Korean.
 * - Speech to text: ElevenLabs Scribe v2 Realtime (WebSocket, single-use token fetched in the browser)
 * - Translation: Gemini first; Google Translate (no key) when Gemini is missing or failing
 * Keys live in localStorage only.
 */
(function () {
  'use strict';

  const $ = (id) => document.getElementById(id);

  const LS = {
    el: 'lc_el_key',
    gm: 'lc_gm_key',
    model: 'lc_gm_model',
    terms: 'lc_terms',
    scale: 'lc_scale',
    segs: 'lc_segments',
  };
  // Keys the HighlightExpression app stores on the same github.io origin.
  const LEGACY = { el: 'practice_elevenlabs_key', gm: 'practice_gemini_key' };

  const DEFAULT_MODEL = 'gemini-3.5-flash-lite';
  const DEFAULT_TERMS = [
    'DFT', 'VASP', 'MLIP', 'SevenNet', 'MACE', 'CatBench', 'adsorption energy', 'binding energy',
    'electrocatalysis', 'catalyst', 'NEB', 'transition state', 'activation barrier', 'slab',
    'step site', 'terrace', 'ruthenium', 'fine-tuning', 'distillation', 'Gibbs free energy',
    'd-band center', 'overpotential', 'machine learning interatomic potential',
    'hydrogen evolution reaction', 'oxygen evolution reaction',
  ].join(', ');

  const VAD_SILENCE_SECS = 0.8; // pause that closes a sentence
  const QUEUE_MAX = 80; // 100 ms chunks kept while (re)connecting = 8 s
  const KEEP_SEGMENTS = 400;
  const PROVISIONAL_MIN_WORDS = 8; // shorter sentences are committed before this matters
  const PROVISIONAL_STEP_WORDS = 5;
  const PROVISIONAL_GAP_MS = 1500;

  // ─── storage ───

  function load(k, d = '') {
    try {
      const v = localStorage.getItem(k);
      return v === null ? d : v;
    } catch (e) {
      return d;
    }
  }

  function save(k, v) {
    try {
      localStorage.setItem(k, v);
    } catch (e) {
      /* storage unavailable (private mode) */
    }
  }

  const elKey = () => load(LS.el) || load(LEGACY.el);
  const gmKey = () => load(LS.gm) || load(LEGACY.gm);
  const gmModel = () => load(LS.model) || DEFAULT_MODEL;

  function termList() {
    const seen = new Set();
    return load(LS.terms, DEFAULT_TERMS)
      .split(/[,\n]/)
      .map((t) => t.trim())
      .filter((t) => t && !seen.has(t.toLowerCase()) && seen.add(t.toLowerCase()));
  }

  // Scribe rejects the whole session if any keyterm is over 20 characters; at most 50 terms.
  const sttTerms = () => termList().filter((t) => t.length <= 20).slice(0, 50);

  // ─── state ───

  let running = false;
  let ws = null;
  let reconnectTimer = null;
  let reconnectDelay = 500;
  let queue = [];
  let prevText = ''; // context for the first chunk after a reconnect
  let audio = null; // { ctx, stream, node }
  let lastChunkAt = 0;
  let wakeLock = null;
  let startedAt = 0;
  let tickTimer = null;
  let resumeOnTap = false;

  let segments = []; // { en, ko, t } or { divider, t }
  const nodes = new WeakMap();
  let live = newLive();

  let gmOffUntil = 0; // Gemini skipped until this time after a hard failure
  let gmTimeouts = 0;
  let engine = { name: '', reason: '' };

  function newLive() {
    return { en: '', ko: '', words: 0, at: 0, busy: false };
  }

  // ─── small UI helpers ───

  function setStatus(kind, text) {
    $('status').className = 'status ' + kind;
    $('status-text').textContent = text;
  }

  let noticeTimer = null;
  function notice(msg, kind = 'warn', ms = 0) {
    const el = $('notice');
    clearTimeout(noticeTimer);
    if (!msg) {
      el.hidden = true;
      return;
    }
    el.textContent = msg;
    el.className = kind;
    el.hidden = false;
    if (ms) noticeTimer = setTimeout(() => (el.hidden = true), ms);
  }

  function setEngine(name, reason = '') {
    if (engine.name === name && engine.reason === reason) return;
    engine = { name, reason };
    const chip = $('engine');
    chip.hidden = !name;
    chip.textContent = name === 'gemini' ? 'Gemini' : name === 'google' ? 'Google 번역' : '번역 오류';
    chip.className = 'chip' + (name === 'gemini' ? '' : ' fallback');
    chip.title = reason;
  }

  function setMainBtn() {
    const b = $('main-btn');
    b.textContent = running ? '멈춤' : '듣기 시작';
    b.className = 'main ' + (running ? 'stop' : 'start');
  }

  function onTick() {
    const s = Math.floor((Date.now() - startedAt) / 1000);
    const h = Math.floor(s / 3600);
    const mm = String(Math.floor(s / 60) % 60).padStart(2, '0');
    const ss = String(s % 60).padStart(2, '0');
    $('timer').textContent = (h ? h + ':' : '') + mm + ':' + ss;
    watchdog();
  }

  function applyScale() {
    document.documentElement.style.setProperty('--scale', load(LS.scale, '1'));
  }

  function isKorean(text) {
    return (text.match(/[가-힣]/g) || []).length >= 2;
  }

  // ─── caption feed ───

  const feed = $('feed');

  function atBottom() {
    return feed.scrollHeight - feed.scrollTop - feed.clientHeight < 60;
  }

  // Keep following new captions unless the user scrolled up to read something.
  function keepPosition(stick) {
    if (stick) feed.scrollTop = feed.scrollHeight;
    $('jump').hidden = stick || atBottom();
  }

  function updateEmpty() {
    $('empty').hidden = segments.length > 0 || !!live.en;
    $('empty-msg').innerHTML = running
      ? '듣고 있어요<br>말소리가 들리면 여기에 자막이 나와요'
      : '폰을 소리 나는 쪽에 두고<br><b>듣기 시작</b>을 누르세요';
    $('empty-key').hidden = !!elKey();
  }

  function segNode(seg) {
    const div = document.createElement('div');
    nodes.set(seg, div);
    if (seg.divider) {
      div.className = 'divider';
      div.textContent = seg.divider;
      return div;
    }
    div.className = 'seg';
    div.innerHTML = '<p class="ko"></p><p class="en"></p>';
    div.addEventListener('click', () => {
      if (seg.failed) translateSeg(seg);
    });
    fillSeg(seg);
    return div;
  }

  function fillSeg(seg, placeholder = '') {
    const div = nodes.get(seg);
    if (!div || seg.divider) return;
    const stick = atBottom();
    const ko = div.firstChild;
    ko.textContent = seg.ko || (seg.failed ? '번역 실패 · 탭해서 다시' : placeholder || '…');
    ko.classList.toggle('pending', !seg.ko);
    div.lastChild.textContent = seg.en;
    keepPosition(stick);
  }

  function addSegment(seg, placeholder) {
    const stick = atBottom();
    segments.push(seg);
    const box = $('segments');
    box.appendChild(segNode(seg));
    if (placeholder) fillSeg(seg, placeholder);
    if (segments.length > KEEP_SEGMENTS + 50) {
      segments.splice(0, 50);
      for (let i = 0; i < 50 && box.firstChild; i++) box.removeChild(box.firstChild);
    }
    updateEmpty();
    keepPosition(stick);
  }

  function renderAll() {
    const box = $('segments');
    box.textContent = '';
    for (const s of segments) box.appendChild(segNode(s));
    updateEmpty();
    feed.scrollTop = feed.scrollHeight;
  }

  function renderLive() {
    const stick = atBottom();
    const box = $('live');
    box.hidden = !live.en;
    box.firstElementChild.textContent = live.ko;
    box.lastElementChild.textContent = live.en;
    updateEmpty();
    keepPosition(stick);
  }

  let persistTimer = null;
  function persist() {
    clearTimeout(persistTimer);
    persistTimer = setTimeout(() => {
      const keep = segments.slice(-KEEP_SEGMENTS).map(({ en, ko, divider, t }) => ({ en, ko, divider, t }));
      save(LS.segs, JSON.stringify(keep));
    }, 400);
  }

  function restore() {
    try {
      segments = JSON.parse(load(LS.segs, '[]')) || [];
    } catch (e) {
      segments = [];
    }
    // A translation still in flight when the page was closed never arrived.
    for (const s of segments) if (!s.divider && s.en && !s.ko) s.failed = true;
    renderAll();
  }

  // ─── transcripts ───

  function onPartial(text) {
    live.en = text;
    renderLive();

    const L = live;
    const words = text.split(/\s+/).filter(Boolean).length;
    if (
      L.busy ||
      isKorean(text) ||
      words < PROVISIONAL_MIN_WORDS ||
      words - L.words < PROVISIONAL_STEP_WORDS ||
      Date.now() - L.at < PROVISIONAL_GAP_MS
    ) {
      return;
    }
    // Long sentence still being spoken: show a provisional translation so far.
    L.busy = true;
    L.words = words;
    L.at = Date.now();
    translate(text, recentContext(segments.length)).then((ko) => {
      L.busy = false;
      if (L === live && ko) {
        live.ko = ko;
        renderLive();
      }
    });
  }

  function commitText(text) {
    text = (text || '').trim();
    const placeholder = live.ko;
    live = newLive();
    renderLive();
    if (!text) return;
    const korean = isKorean(text);
    const seg = { en: korean ? '' : text, ko: korean ? text : '', t: Date.now() };
    addSegment(seg, placeholder);
    if (!korean) translateSeg(seg);
    persist();
  }

  function flushLive() {
    if (live.en) commitText(live.en);
  }

  // English of the two sentences before index i, to disambiguate fragments.
  function recentContext(i) {
    return segments
      .slice(Math.max(0, i - 4), i)
      .map((s) => s.en)
      .filter(Boolean)
      .slice(-2);
  }

  async function translateSeg(seg) {
    seg.failed = false;
    fillSeg(seg);
    const ko = await translate(seg.en, recentContext(segments.indexOf(seg)));
    seg.ko = ko;
    seg.failed = !ko;
    fillSeg(seg);
    persist();
  }

  // ─── translation ───

  function fetchTimeout(url, opts, ms) {
    const ac = new AbortController();
    const t = setTimeout(() => ac.abort(), ms);
    return fetch(url, { ...opts, signal: ac.signal }).finally(() => clearTimeout(t));
  }

  async function translate(text, context) {
    const key = gmKey();
    if (!key) {
      setEngine('google', 'Gemini 키 없음');
    } else if (Date.now() >= gmOffUntil) {
      try {
        const ko = await gemini(text, context, key);
        gmTimeouts = 0;
        setEngine('gemini');
        return ko;
      } catch (e) {
        if (e.name === 'AbortError') {
          if (++gmTimeouts >= 2) {
            gmOffUntil = Date.now() + 2 * 60e3;
            gmTimeouts = 0;
          }
          setEngine('google', 'Gemini 응답 지연');
        } else {
          // Key, credit, or model problems will not fix themselves within a meeting.
          if (e.status && e.status < 500 && e.status !== 429) gmOffUntil = Date.now() + 10 * 60e3;
          setEngine('google', e.message);
        }
      }
    }
    try {
      return await google(text);
    } catch (e) {
      setEngine('error', e.message);
      return '';
    }
  }

  async function gemini(text, context, key) {
    const terms = termList().join(', ');
    const sys = [
      'You are a live interpreter for a Korean researcher listening to spoken English (Zoom meetings, conference talks, Q&A).',
      'Translate the given speech-recognition text into natural, concise Korean in polite spoken style (존댓말).',
      'Output ONLY the Korean translation: no quotes, notes, alternatives, or romanization.',
      'The text may be an unfinished sentence or contain recognition errors. Translate the intended meaning of what is there; do not complete it.',
      'Keep acronyms, model and software names, chemical formulas, and numbers as written. For technical terms use the Korean wording researchers actually use, keeping the English term where that is the norm.',
      terms ? 'Domain terms that may appear: ' + terms + '.' : '',
    ]
      .filter(Boolean)
      .join('\n');
    const prompt =
      (context.length ? 'Earlier sentences (context only, do not translate):\n' + context.join('\n') + '\n\n' : '') +
      'Translate:\n' +
      text;

    const res = await fetchTimeout(
      `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(gmModel())}:generateContent?key=${encodeURIComponent(key)}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          systemInstruction: { parts: [{ text: sys }] },
          contents: [{ role: 'user', parts: [{ text: prompt }] }],
          generationConfig: { temperature: 0.2, maxOutputTokens: 1024 },
        }),
      },
      4000
    );
    if (!res.ok) {
      const label =
        { 400: '요청 오류', 401: '키 오류', 402: '크레딧 소진', 403: '키 권한 없음', 404: '모델 이름 오류', 429: '한도 초과' }[
          res.status
        ] || '오류';
      const err = new Error(`Gemini ${label} (${res.status})`);
      err.status = res.status;
      throw err;
    }
    const d = await res.json();
    const out = (d.candidates?.[0]?.content?.parts || [])
      .map((p) => p.text || '')
      .join('')
      .trim();
    if (!out) throw new Error('Gemini 빈 응답');
    return out;
  }

  async function google(text) {
    const res = await fetchTimeout(
      'https://translate.googleapis.com/translate_a/single?client=gtx&sl=en&tl=ko&dt=t&q=' + encodeURIComponent(text),
      {},
      5000
    );
    if (!res.ok) throw new Error('Google 번역 오류 (' + res.status + ')');
    const d = await res.json();
    return (d[0] || [])
      .map((x) => x[0])
      .join('')
      .trim();
  }

  // ─── speech-to-text socket ───

  function lastEnglishTail() {
    for (let i = segments.length - 1; i >= 0; i--) {
      const en = segments[i].en;
      if (en) return en.length <= 50 ? en : en.slice(-50).replace(/^\S*\s/, '');
    }
    return '';
  }

  async function connect() {
    clearTimeout(reconnectTimer);
    if (!running) return;
    let token;
    try {
      const res = await fetchTimeout(
        'https://api.elevenlabs.io/v1/single-use-token/realtime_scribe',
        { method: 'POST', headers: { 'xi-api-key': elKey() } },
        8000
      );
      if (res.status === 401 || res.status === 403) {
        fail(`ElevenLabs 키가 거부됐어요 (${res.status}). 설정에서 키를 확인하세요.`);
        return;
      }
      if (!res.ok) throw new Error('token ' + res.status);
      token = (await res.json()).token;
    } catch (e) {
      retry();
      return;
    }
    if (!running) return;

    const p = new URLSearchParams({
      model_id: 'scribe_v2_realtime',
      token,
      audio_format: 'pcm_16000',
      language_code: 'en',
      commit_strategy: 'vad',
      vad_silence_threshold_secs: String(VAD_SILENCE_SECS),
    });
    for (const t of sttTerms()) p.append('keyterms', t);

    const sock = new WebSocket('wss://api.elevenlabs.io/v1/speech-to-text/realtime?' + p);
    ws = sock;
    sock.onopen = () => {
      if (ws !== sock) return;
      const q = queue;
      queue = [];
      for (const b64 of q) sendChunk(b64);
    };
    sock.onmessage = (ev) => {
      if (ws === sock) onMessage(JSON.parse(ev.data));
    };
    sock.onclose = () => {
      if (ws !== sock) return;
      ws = null;
      flushLive();
      if (running) {
        prevText = lastEnglishTail();
        retry();
      }
    };
  }

  function retry() {
    if (!running) return;
    setStatus('connecting', '재연결 중');
    clearTimeout(reconnectTimer);
    reconnectTimer = setTimeout(connect, reconnectDelay);
    reconnectDelay = Math.min(reconnectDelay * 2, 5000);
  }

  function onMessage(d) {
    switch (d.message_type) {
      case 'session_started':
        reconnectDelay = 500;
        setStatus('live', '듣는 중');
        break;
      case 'partial_transcript':
        onPartial(d.text || '');
        break;
      case 'committed_transcript':
        commitText(d.text);
        break;
      case 'auth_error':
        fail('ElevenLabs 인증 오류: ' + d.error);
        break;
      case 'quota_exceeded':
        fail('ElevenLabs 사용 한도를 넘었어요: ' + d.error);
        break;
      case 'unaccepted_terms':
        fail('ElevenLabs 약관 동의가 필요해요: ' + d.error);
        break;
      case 'invalid_request':
        fail('음성 인식 요청 오류: ' + d.error);
        break;
      default:
        // Transient errors close the socket; onclose reconnects.
        if (d.error) console.warn(d.message_type, d.error);
    }
  }

  function sendChunk(b64) {
    const msg = { message_type: 'input_audio_chunk', audio_base_64: b64, commit: false, sample_rate: 16000 };
    if (prevText) {
      msg.previous_text = prevText; // only allowed on a session's first chunk
      prevText = '';
    }
    try {
      ws.send(JSON.stringify(msg));
    } catch (e) {
      /* socket closing; onclose handles it */
    }
  }

  function toBase64(buf) {
    const b = new Uint8Array(buf);
    let s = '';
    for (let i = 0; i < b.length; i += 0x8000) s += String.fromCharCode.apply(null, b.subarray(i, i + 0x8000));
    return btoa(s);
  }

  function onAudio(buf) {
    lastChunkAt = Date.now();
    const b64 = toBase64(buf);
    if (ws && ws.readyState === WebSocket.OPEN) {
      sendChunk(b64);
    } else {
      queue.push(b64); // speech during (re)connect is sent once the socket opens
      if (queue.length > QUEUE_MAX) queue.shift();
    }
  }

  // ─── microphone ───

  async function startAudio(ctx) {
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: { channelCount: 1, echoCancellation: false, noiseSuppression: true, autoGainControl: true },
    });
    await ctx.audioWorklet.addModule('worklet.js');
    const node = new AudioWorkletNode(ctx, 'pcm16k');
    node.port.onmessage = (e) => onAudio(e.data);
    ctx.createMediaStreamSource(stream).connect(node);
    node.connect(ctx.destination); // keeps the node pulled on every browser; it outputs silence
    if (ctx.state !== 'running') await ctx.resume();
    audio = { ctx, stream, node };
    if (!running) stopAudio(); // stopped while the permission prompt was open
  }

  function stopAudio() {
    if (!audio) return;
    audio.stream.getTracks().forEach((t) => t.stop());
    audio.node.port.onmessage = null;
    audio.ctx.close().catch(() => {});
    audio = null;
  }

  // iOS cuts the mic when the screen locks, another app takes audio, or a call comes in.
  function watchdog() {
    if (!running || !audio) return;
    const silentFor = Date.now() - lastChunkAt;
    if (silentFor < 2500) return;
    if (audio.ctx.state !== 'running') audio.ctx.resume().catch(() => {});
    const track = audio.stream.getAudioTracks()[0];
    if (!track || track.readyState === 'ended' || silentFor > 6000) {
      stop();
      resumeOnTap = true;
      notice('마이크가 끊겼어요 · 화면을 탭하면 다시 들어요');
      setStatus('error', '끊김');
    }
  }

  async function acquireWakeLock() {
    if (!('wakeLock' in navigator) || wakeLock) return;
    try {
      wakeLock = await navigator.wakeLock.request('screen');
      wakeLock.addEventListener('release', () => (wakeLock = null));
    } catch (e) {
      /* not allowed right now; retried when the page is visible again */
    }
  }

  function releaseWakeLock() {
    if (wakeLock) wakeLock.release().catch(() => {});
    wakeLock = null;
  }

  // ─── start / stop ───

  async function start() {
    if (running) return;
    if (!elKey()) {
      openSettings();
      return;
    }
    // Create the audio context inside the tap so iOS lets it run.
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    ctx.resume().catch(() => {});

    running = true;
    resumeOnTap = false;
    queue = [];
    prevText = '';
    reconnectDelay = 500;
    live = newLive();
    notice('');
    const last = segments[segments.length - 1];
    if (last && !last.divider) {
      const label = new Date().toLocaleString('ko-KR', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
      addSegment({ divider: label, t: Date.now() });
      persist();
    }
    setMainBtn();
    setStatus('connecting', '연결 중');
    updateEmpty();
    startedAt = Date.now();
    lastChunkAt = Date.now();
    clearInterval(tickTimer);
    tickTimer = setInterval(onTick, 1000);
    onTick();
    acquireWakeLock();

    connect();
    try {
      await startAudio(ctx);
    } catch (e) {
      ctx.close().catch(() => {});
      fail(
        e.name === 'NotAllowedError'
          ? '마이크 권한이 필요해요. 브라우저 설정에서 이 사이트의 마이크를 허용해 주세요.'
          : '마이크를 열 수 없어요: ' + e.message
      );
    }
  }

  function stop() {
    if (!running) return;
    running = false;
    clearTimeout(reconnectTimer);
    clearInterval(tickTimer);
    const sock = ws;
    ws = null;
    if (sock) {
      try {
        sock.close();
      } catch (e) {
        /* already closed */
      }
    }
    flushLive();
    stopAudio();
    queue = [];
    releaseWakeLock();
    setMainBtn();
    setStatus('idle', '대기');
    updateEmpty();
  }

  function fail(msg) {
    stop();
    notice(msg);
    setStatus('error', '멈춤');
  }

  // ─── settings ───

  function updateTermsNote() {
    const all = $('terms')
      .value.split(/[,\n]/)
      .map((t) => t.trim())
      .filter(Boolean);
    const long = all.filter((t) => t.length > 20);
    $('terms-note').textContent = long.length
      ? `20자 넘는 용어(${long.length}개)는 번역에만 쓰이고 음성 인식 힌트에서는 빠져요.`
      : '';
  }

  function updateEngineNote() {
    let msg = '';
    if (!gmKey()) msg = 'Gemini 키가 없어서 Google 번역(무료)을 써요. 전문용어 번역은 Gemini가 더 정확해요.';
    else if (engine.name === 'google') msg = `지금은 Google 번역으로 대신하는 중 (${engine.reason}).`;
    else if (engine.name === 'gemini') msg = 'Gemini로 번역하는 중이에요.';
    $('engine-note').textContent = msg;
  }

  function openSettings() {
    $('el-key').value = elKey();
    $('gm-key').value = gmKey();
    $('gm-model').value = gmModel();
    $('terms').value = load(LS.terms, DEFAULT_TERMS);
    $('font').value = load(LS.scale, '1');
    updateTermsNote();
    updateEngineNote();
    $('settings').showModal();
  }

  $('settings')
    .querySelector('form')
    .addEventListener('submit', () => {
      const before = gmKey() + '|' + gmModel();
      let el = $('el-key').value.trim();
      let gm = $('gm-key').value.trim();
      // A setup link pasted into either key field fills both (home-screen apps on iOS don't share Safari's storage).
      const link = [el, gm].find((v) => /(^|[#&?])el=/.test(v));
      if (link) {
        const h = new URLSearchParams(link.slice(link.indexOf('#') + 1));
        el = h.get('el') || '';
        gm = h.get('gm') || (gm === link ? '' : gm);
      }
      save(LS.el, el);
      save(LS.gm, gm);
      save(LS.model, $('gm-model').value.trim() || DEFAULT_MODEL);
      save(LS.terms, $('terms').value);
      save(LS.scale, $('font').value);
      if (gmKey() + '|' + gmModel() !== before) {
        gmOffUntil = 0; // give Gemini another chance with the new key or model
        setEngine('');
      }
      applyScale();
      updateEmpty();
    });

  $('terms').addEventListener('input', updateTermsNote);
  $('font').addEventListener('input', () => {
    document.documentElement.style.setProperty('--scale', $('font').value);
  });
  $('clear-btn').addEventListener('click', () => {
    if (!confirm('자막 기록을 모두 지울까요?')) return;
    segments = [];
    renderAll();
    persist();
  });

  // Setup link: …/LiveCaption/#el=<ElevenLabs key>&gm=<Gemini key>. The hash never reaches the server.
  function importKeysFromHash() {
    const h = new URLSearchParams(location.hash.slice(1));
    if (!h.get('el') && !h.get('gm')) return;
    if (h.get('el')) save(LS.el, h.get('el').trim());
    if (h.get('gm')) save(LS.gm, h.get('gm').trim());
    history.replaceState(null, '', location.pathname + location.search);
    notice('API 키를 저장했어요', 'info', 4000);
  }

  // ─── wiring ───

  $('main-btn').addEventListener('click', () => (running ? stop() : start()));
  $('settings-btn').addEventListener('click', openSettings);
  $('jump').addEventListener('click', () => {
    feed.scrollTop = feed.scrollHeight;
    $('jump').hidden = true;
  });
  feed.addEventListener('scroll', () => {
    if (atBottom()) $('jump').hidden = true;
  });
  document.addEventListener('pointerdown', (e) => {
    if (!resumeOnTap || running || e.target.closest('#settings, #settings-btn, #main-btn')) return;
    start();
  });
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState !== 'visible' || !running) return;
    acquireWakeLock();
    if (audio) {
      // Timers were frozen in the background; give the mic a moment to come back before the watchdog judges it.
      lastChunkAt = Math.max(lastChunkAt, Date.now() - 2000);
      audio.ctx.resume().catch(() => {});
    }
  });

  importKeysFromHash();
  applyScale();
  restore();
  setMainBtn();

  // Test hook: drop the socket to exercise reconnection.
  window.__lc = { dropSocket: () => ws && ws.close() };
})();

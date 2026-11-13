const LANGS = [
  { id: 'zh-TW', speech: 'zh-TW', translate: 'zh-TW', tts: 'zh-TW', label: '繁體中文', short: '繁中' },
  { id: 'zh-CN', speech: 'zh-CN', translate: 'zh-CN', tts: 'zh-CN', label: '簡體中文', short: '簡中' },
  { id: 'en-US', speech: 'en-US', translate: 'en', tts: 'en-US', label: 'English', short: 'EN' },
  { id: 'ja-JP', speech: 'ja-JP', translate: 'ja', tts: 'ja-JP', label: '日本語', short: '日' },
  { id: 'ko-KR', speech: 'ko-KR', translate: 'ko', tts: 'ko-KR', label: '한국어', short: '韓' },
  { id: 'es-ES', speech: 'es-ES', translate: 'es', tts: 'es-ES', label: 'Español', short: 'ES' },
  { id: 'fr-FR', speech: 'fr-FR', translate: 'fr', tts: 'fr-FR', label: 'Français', short: 'FR' },
  { id: 'de-DE', speech: 'de-DE', translate: 'de', tts: 'de-DE', label: 'Deutsch', short: 'DE' },
  { id: 'vi-VN', speech: 'vi-VN', translate: 'vi', tts: 'vi-VN', label: 'Tiếng Việt', short: '越' },
  { id: 'th-TH', speech: 'th-TH', translate: 'th', tts: 'th-TH', label: 'ไทย', short: '泰' },
  { id: 'id-ID', speech: 'id-ID', translate: 'id', tts: 'id-ID', label: 'Indonesia', short: 'ID' },
];

const PREF_KEY = 'align.v1';
const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;

const sourceSelect = document.querySelector('#sourceLang');
const targetSelect = document.querySelector('#targetLang');
const swapBtn = document.querySelector('#swapBtn');
const mic = document.querySelector('#mic');
const micLabel = document.querySelector('#micLabel');
const iconMic = document.querySelector('.icon-mic');
const iconStop = document.querySelector('.icon-stop');
const autoSpeak = document.querySelector('#autoSpeak');
const sourceText = document.querySelector('#sourceText');
const targetText = document.querySelector('#targetText');
const sourceGhost = document.querySelector('#sourceGhost');
const targetGhost = document.querySelector('#targetGhost');
const sourceCode = document.querySelector('#sourceCode');
const targetCode = document.querySelector('#targetCode');
const statusEl = document.querySelector('#status');
const statusText = document.querySelector('#statusText');
const banner = document.querySelector('#banner');
const hint = document.querySelector('#hint');
const historyEl = document.querySelector('#history');
const emptyLog = document.querySelector('#emptyLog');
const clearBtn = document.querySelector('#clearBtn');
const copyBtn = document.querySelector('#copyBtn');
const bars = document.querySelector('#bars');
const progress = document.querySelector('#progress');
const latencyEl = document.querySelector('#latency');
const pendingChip = document.querySelector('#pendingChip');
const announcer = document.querySelector('#announcer');
const stage = document.querySelector('#stage');

const state = {
  session: false,
  holding: false,
  speaking: false,
  pending: false,
  interim: '',
  interimTranslation: '',
  lastFinal: null,
  history: [],
  error: '',
  latency: '',
};

let pendingCount = 0;
let interimTimer = 0;
let interimToken = 0;
let viewGen = 0;
let utteranceSerial = 0;
let historyStamp = '';
let recActive = false;
let finishSpeak = null;
let queue = Promise.resolve();
const cache = new Map();

let rec = null;
if (SpeechRecognition) {
  rec = new SpeechRecognition();
  rec.continuous = true;
  rec.interimResults = true;
  rec.maxAlternatives = 1;
}

function langById(id) {
  return LANGS.find((item) => item.id === id) || LANGS[0];
}

function currentSource() {
  return langById(sourceSelect.value);
}

function currentTarget() {
  return langById(targetSelect.value);
}

function fillSelect(select) {
  for (const lang of LANGS) {
    const option = document.createElement('option');
    option.value = lang.id;
    option.textContent = lang.label;
    select.append(option);
  }
}

function loadPrefs() {
  try {
    const data = JSON.parse(localStorage.getItem(PREF_KEY) || '{}');
    return data && typeof data === 'object' ? data : {};
  } catch {
    return {};
  }
}

function savePrefs() {
  try {
    localStorage.setItem(PREF_KEY, JSON.stringify({
      source: sourceSelect.value,
      target: targetSelect.value,
      speak: autoSpeak.checked,
    }));
  } catch {
    // 隱私模式可能無法寫入，語言選擇仍可在這一輪使用。
  }
}

function meaningful(text) {
  return /[\p{L}\p{N}]/u.test(text);
}

function worthInterim(text) {
  const value = text.trim();
  if (/[\u3400-\u9fff\u3040-\u30ff\uac00-\ud7af]/.test(value)) return value.length >= 1;
  return value.length >= 2;
}

function cacheKey(text, sl, tl) {
  return `${sl}|${tl}|${text.trim()}`;
}

function remember(key, value) {
  if (cache.has(key)) cache.delete(key);
  cache.set(key, value);
  if (cache.size > 200) cache.delete(cache.keys().next().value);
}

function peek(text, sl, tl) {
  return cache.get(cacheKey(text, sl, tl)) || '';
}

function setPending(delta) {
  pendingCount += delta;
  if (pendingCount < 0) pendingCount = 0;
  state.pending = pendingCount > 0;
}

function phase() {
  if (state.speaking) return 'speak';
  if (state.pending) return 'translate';
  if (state.session) return 'listen';
  return 'idle';
}

function currentView() {
  if (state.interim) {
    return {
      source: state.interim,
      translation: state.interimTranslation,
      live: true,
    };
  }
  if (state.lastFinal?.source) {
    return {
      source: state.lastFinal.source,
      translation: state.lastFinal.translation,
      live: false,
    };
  }
  return null;
}

function announce(text) {
  announcer.textContent = '';
  requestAnimationFrame(() => {
    announcer.textContent = text;
  });
}

function langByKey(key) {
  return LANGS.find((lang) => lang.id === key || lang.label === key);
}

function langRank(key) {
  const index = LANGS.findIndex((lang) => lang.id === key || lang.label === key);
  return index === -1 ? LANGS.length : index;
}

function renderHistory() {
  const stamp = state.history
    .map((item) => `${item.sourceId}|${item.targetId}|${item.source}\u0000${item.translation}\u0000${item.targetLabel}`)
    .join('\n');
  if (stamp === historyStamp) return;
  historyStamp = stamp;
  historyEl.replaceChildren();

  const groups = [];
  const byKey = new Map();
  state.history.forEach((item, index) => {
    const sourceKey = item.sourceId || item.sourceLabel;
    const targetKey = item.targetId || item.targetLabel;
    const pair = [sourceKey, targetKey].sort().join('|');
    let group = byKey.get(pair);
    if (!group) {
      group = {
        columns: [...new Set([sourceKey, targetKey])].sort((a, b) => langRank(a) - langRank(b)),
        rows: [],
      };
      byKey.set(pair, group);
      groups.push(group);
    }
    group.rows.push({ index, item, sourceKey, targetKey });
  });

  for (const group of groups) {
    const section = document.createElement('section');
    section.className = 'lang-group';
    const columns = `repeat(${group.columns.length}, minmax(0, 1fr)) auto`;
    const names = group.columns.map((key) => langByKey(key)?.label || key);
    section.setAttribute('aria-label', names.join('、'));

    const head = document.createElement('div');
    head.className = 'lang-head';
    head.style.gridTemplateColumns = columns;
    for (const key of group.columns) {
      const title = document.createElement('span');
      const lang = langByKey(key);
      title.className = 'col-title';
      title.textContent = lang?.short || key;
      title.title = lang?.label || key;
      head.append(title);
    }
    head.append(document.createElement('span'));

    section.append(head);
    for (const row of group.rows) {
      const line = document.createElement('div');
      line.className = 'lang-row';
      line.style.gridTemplateColumns = columns;
      const texts = new Map([
        [row.sourceKey, row.item.source],
        [row.targetKey, row.item.translation],
      ]);
      for (const key of group.columns) {
        const text = document.createElement('p');
        text.className = 'col-text';
        text.lang = langByKey(key)?.tts || '';
        text.textContent = texts.get(key) || '';
        line.append(text);
      }
      const actions = document.createElement('div');
      actions.className = 'row-actions';
      const time = document.createElement('time');
      time.className = 'row-time';
      time.textContent = row.item.at;
      time.dateTime = row.item.at;
      const replay = document.createElement('button');
      replay.type = 'button';
      replay.className = 'text-btn';
      replay.dataset.speak = String(row.index);
      replay.textContent = '朗讀';
      actions.append(time, replay);
      line.append(actions);
      section.append(line);
    }
    historyEl.append(section);
  }

  const scroller = historyEl.closest('.log');
  if (scroller) scroller.scrollTop = scroller.scrollHeight;
}

function render() {
  const view = currentView();
  const mode = phase();
  const labels = {
    idle: '待命',
    listen: '聆聽中',
    translate: '翻譯中',
    speak: '朗讀中',
  };

  statusEl.className = `status ${mode}`;
  statusText.textContent = labels[mode];

  const listening = state.session && !state.speaking;
  mic.classList.toggle('live', listening);
  mic.setAttribute('aria-pressed', state.session ? 'true' : 'false');
  iconMic.hidden = state.session;
  iconStop.hidden = !state.session;
  if (state.session && state.speaking) micLabel.textContent = '朗讀中';
  else if (state.session) micLabel.textContent = '停止聆聽';
  else micLabel.textContent = '開始聆聽';
  bars.hidden = !listening;

  sourceCode.textContent = currentSource().short;
  targetCode.textContent = currentTarget().short;
  sourceText.lang = currentSource().tts;
  targetText.lang = currentTarget().tts;

  sourceGhost.hidden = Boolean(view?.source);
  sourceText.hidden = !view?.source;
  sourceText.textContent = view?.source || '';
  sourceText.classList.toggle('interim', Boolean(view?.live));

  const showWaiting = Boolean(view?.source) && !view?.translation && state.pending;
  targetGhost.hidden = Boolean(view?.translation) || showWaiting;
  targetText.hidden = !view?.translation && !showWaiting;
  targetText.textContent = view?.translation || (showWaiting ? '翻譯中…' : '');
  targetText.classList.toggle('interim', Boolean(view?.live && view?.translation));
  targetText.classList.toggle('waiting', showWaiting);

  latencyEl.hidden = !state.latency || Boolean(state.interim);
  latencyEl.textContent = state.latency ? `延遲 ${state.latency}` : '';
  pendingChip.hidden = !state.pending;
  progress.classList.toggle('on', state.pending);
  stage.setAttribute('aria-busy', state.pending ? 'true' : 'false');

  banner.hidden = !state.error;
  banner.textContent = state.error;

  copyBtn.disabled = !view?.translation;
  emptyLog.hidden = state.history.length > 0;
  clearBtn.disabled = state.history.length === 0;
  renderHistory();
}

async function translate(text, sl, tl) {
  const source = (sl || currentSource().translate).trim();
  const target = (tl || currentTarget().translate).trim();
  const clean = text.trim();
  if (!clean) return '';
  if (source === target) return clean;
  const key = cacheKey(clean, source, target);
  if (cache.has(key)) return cache.get(key);

  let response;
  try {
    response = await fetch('/api/translate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ q: clean, sl: source, tl: target }),
    });
  } catch {
    throw new Error('無法連到翻譯服務。請在此資料夾執行 node server.mjs 後再開啟頁面。');
  }

  const data = await response.json().catch(() => ({}));
  if (!response.ok || !data.translation) {
    throw new Error(data.error || '翻譯服務暫時沒有回應');
  }
  remember(key, data.translation);
  return data.translation;
}

function scheduleInterim(text, delay = 480) {
  clearTimeout(interimTimer);
  const my = ++interimToken;
  const sl = currentSource().translate;
  const tl = currentTarget().translate;
  const cached = peek(text, sl, tl);
  if (cached) {
    state.interimTranslation = cached;
    state.latency = '';
    render();
    return;
  }
  interimTimer = setTimeout(async () => {
    setPending(1);
    render();
    try {
      const translation = await translate(text, sl, tl);
      if (my !== interimToken || state.interim !== text) return;
      state.interimTranslation = translation;
      state.error = '';
    } catch (error) {
      if (my !== interimToken) return;
      state.error = error.message || '翻譯失敗';
    } finally {
      setPending(-1);
      render();
    }
  }, delay);
}

function enqueue(task) {
  const run = queue.then(task, task);
  queue = run.then(() => {}, () => {});
  return run;
}

function chooseVoice(lang) {
  const voices = window.speechSynthesis?.getVoices?.() || [];
  const norm = lang.toLowerCase();
  const short = norm.slice(0, 2);
  return voices.find((voice) => voice.lang.toLowerCase() === norm)
    || voices.find((voice) => voice.lang.toLowerCase().replace('_', '-').startsWith(short))
    || null;
}

function speakText(text, lang) {
  if (!text || !window.speechSynthesis) return Promise.resolve();
  return new Promise((resolve) => {
    let settled = false;
    const timer = setTimeout(done, 20000);
    const startedAt = Date.now();
    const poll = setInterval(() => {
      if (settled) {
        clearInterval(poll);
        return;
      }
      if (!window.speechSynthesis.speaking && Date.now() - startedAt > 1200) done();
    }, 200);
    function done() {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearInterval(poll);
      if (finishSpeak === done) finishSpeak = null;
      resolve();
    }
    finishSpeak = done;
    const utter = new SpeechSynthesisUtterance(text);
    utter.lang = lang;
    const voice = chooseVoice(lang);
    if (voice) utter.voice = voice;
    utter.rate = 1.03;
    utter.onend = done;
    utter.onerror = done;
    window.speechSynthesis.cancel();
    window.setTimeout(() => {
      if (!settled) window.speechSynthesis.speak(utter);
    }, 60);
  });
}

function waitForEnd(trigger) {
  return new Promise((resolve) => {
    if (!rec) {
      resolve();
      return;
    }
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      resolve();
    };
    rec.addEventListener('end', finish, { once: true });
    try {
      trigger();
    } catch {
      finish();
    }
    setTimeout(finish, 1000);
  });
}

async function stopRecognition() {
  if (!rec || !recActive) return;
  await waitForEnd(() => rec.stop());
  if (recActive) await waitForEnd(() => rec.abort());
}

function startRecSafe() {
  if (!rec || !state.session || state.holding || recActive) return;
  rec.lang = currentSource().speech;
  try {
    rec.start();
  } catch {
    // 辨識器已在運行時，下一次 onend 會再啟動。
  }
}

async function withMicPaused(task) {
  const resume = state.session;
  state.holding = true;
  state.speaking = true;
  render();
  try {
    if (resume) await stopRecognition();
    await task();
  } finally {
    state.speaking = false;
    state.holding = false;
    render();
    if (resume && state.session) startRecSafe();
  }
}

function ownsStage(id, gen) {
  return gen === viewGen && state.lastFinal?.id === id;
}

async function handleFinal(text, sourceLang, targetLang, gen, id) {
  const sl = sourceLang.translate;
  const tl = targetLang.translate;
  const started = performance.now();
  let translation = peek(text, sl, tl);

  if (!translation) {
    setPending(1);
    render();
    try {
      translation = await translate(text, sl, tl);
    } catch (error) {
      if (ownsStage(id, gen)) state.error = error.message || '翻譯失敗';
      translation = '';
    } finally {
      setPending(-1);
    }
  }

  if (!translation) {
    render();
    return;
  }

  const elapsed = (performance.now() - started) / 1000;
  state.history.push({
    source: text,
    translation,
    sourceId: sourceLang.id,
    targetId: targetLang.id,
    sourceLabel: sourceLang.label,
    targetLabel: targetLang.label,
    targetTts: targetLang.tts,
    at: new Date().toLocaleTimeString('zh-TW', { hour: '2-digit', minute: '2-digit' }),
  });
  if (state.history.length > 50) state.history.shift();

  if (ownsStage(id, gen)) {
    state.lastFinal = { id, source: text, translation, sourceLang, targetLang };
    if (!state.interim) state.latency = elapsed < 0.05 ? '' : `${elapsed.toFixed(1)} 秒`;
    state.error = '';
    announce(`${targetLang.label}：${translation}`);
  }
  render();

  if (ownsStage(id, gen) && autoSpeak.checked) {
    await withMicPaused(() => speakText(translation, targetLang.tts));
  }
}

let lastCommit = { text: '', at: 0 };

function commitUtterance(text) {
  const clean = text.trim();
  if (!meaningful(clean)) return;
  const now = Date.now();
  if (lastCommit.text === clean && now - lastCommit.at < 1200) return;
  lastCommit = { text: clean, at: now };
  const sourceLang = currentSource();
  const targetLang = currentTarget();
  const gen = viewGen;
  const id = ++utteranceSerial;
  interimToken += 1;
  clearTimeout(interimTimer);
  state.interim = '';
  state.interimTranslation = '';
  state.lastFinal = {
    id,
    source: clean,
    translation: peek(clean, sourceLang.translate, targetLang.translate),
    sourceLang,
    targetLang,
  };
  state.latency = '';
  state.error = '';
  render();
  enqueue(() => handleFinal(clean, sourceLang, targetLang, gen, id));
}

async function retranslateWorkbench() {
  const gen = viewGen;
  const fromInterim = Boolean(state.interim);
  const text = (state.interim || state.lastFinal?.source || '').trim();
  const id = state.lastFinal?.id ?? null;
  if (!meaningful(text)) {
    render();
    return;
  }
  const sourceLang = currentSource();
  const targetLang = currentTarget();
  if (fromInterim) {
    if (gen !== viewGen || state.interim !== text) return;
    state.interimTranslation = peek(text, sourceLang.translate, targetLang.translate);
    scheduleInterim(text, 0);
    return;
  }

  setPending(1);
  render();
  try {
    const translation = await translate(text, sourceLang.translate, targetLang.translate);
    if (gen !== viewGen || state.lastFinal?.id !== id) return;
    state.lastFinal = { id, source: text, translation, sourceLang, targetLang };
    const last = state.history.at(-1);
    if (last && last.source === text) {
      last.translation = translation;
      last.sourceId = sourceLang.id;
      last.targetId = targetLang.id;
      last.sourceLabel = sourceLang.label;
      last.targetLabel = targetLang.label;
      last.targetTts = targetLang.tts;
    }
    state.error = '';
  } catch (error) {
    if (gen === viewGen && state.lastFinal?.id === id) state.error = error.message || '翻譯失敗';
  } finally {
    setPending(-1);
    render();
  }
}

function restartListenerSoon() {
  if (!rec) return;
  rec.lang = currentSource().speech;
  if (state.session && !state.holding && recActive) {
    try { rec.stop(); } catch { /* onend 會再啟動 */ }
  }
}

function startSession() {
  if (!rec) return;
  state.error = '';
  state.session = true;
  state.holding = false;
  render();
  startRecSafe();
}

function stopSession() {
  state.session = false;
  window.speechSynthesis?.cancel();
  finishSpeak?.();
  if (rec) {
    try { rec.stop(); } catch { /* 尚未開始 */ }
  }
  render();
}

function toggleMic() {
  if (!rec) return;
  if (state.session) stopSession();
  else startSession();
}

if (rec) {
  rec.onstart = () => {
    recActive = true;
    render();
  };
  rec.onend = () => {
    recActive = false;
    if (state.session && !state.holding) {
      setTimeout(() => startRecSafe(), 180);
    } else {
      render();
    }
  };
  rec.onerror = (event) => {
    const code = event.error;
    if (code === 'no-speech' || code === 'aborted') return;
    if (code === 'not-allowed' || code === 'service-not-allowed') {
      state.session = false;
      state.error = '無法使用麥克風。請允許瀏覽器使用麥克風後再試。';
    } else if (code === 'audio-capture') {
      state.session = false;
      state.error = '找不到麥克風。';
    } else if (code === 'network') {
      state.session = false;
      state.error = '語音辨識服務連不上。請確認網路，並使用 Chrome 或 Edge。';
    } else if (code === 'language-not-supported') {
      state.session = false;
      state.error = '這個瀏覽器不支援所選語言的語音辨識。';
    } else {
      state.error = '語音辨識中斷，請再試一次。';
    }
    render();
  };
  rec.onresult = (event) => {
    let interim = '';
    let finalText = '';
    for (let i = event.resultIndex; i < event.results.length; i += 1) {
      const chunk = event.results[i][0].transcript;
      if (event.results[i].isFinal) finalText += chunk;
      else interim += chunk;
    }
    interim = interim.trim();
    finalText = finalText.trim();
    if (finalText) commitUtterance(finalText);
    if (interim) {
      const starting = !state.interim;
      state.interim = interim;
      if (starting) state.interimTranslation = '';
      state.latency = '';
      state.error = '';
      if (worthInterim(interim)) scheduleInterim(interim);
      render();
    } else if (finalText) {
      state.interim = '';
      render();
    }
  };
} else {
  state.error = '這個瀏覽器不支援語音辨識。請改用 Chrome 或 Edge。';
  mic.disabled = true;
  hint.textContent = '請改用 Chrome 或 Edge，才能使用麥克風。';
}

fillSelect(sourceSelect);
fillSelect(targetSelect);
const prefs = loadPrefs();
sourceSelect.value = LANGS.some((lang) => lang.id === prefs.source) ? prefs.source : 'zh-TW';
targetSelect.value = LANGS.some((lang) => lang.id === prefs.target) ? prefs.target : 'en-US';
autoSpeak.checked = prefs.speak !== false;

sourceSelect.addEventListener('change', () => {
  savePrefs();
  restartListenerSoon();
  enqueue(() => retranslateWorkbench());
});

targetSelect.addEventListener('change', () => {
  savePrefs();
  enqueue(() => retranslateWorkbench());
});

function exchangeLanguages() {
  viewGen += 1;
  interimToken += 1;
  clearTimeout(interimTimer);
  const nextSource = targetSelect.value;
  const nextTarget = sourceSelect.value;
  sourceSelect.value = nextSource;
  targetSelect.value = nextTarget;
  savePrefs();

  if (state.interim && state.interimTranslation) {
    const spoken = state.interim;
    state.interim = state.interimTranslation;
    state.interimTranslation = spoken;
  } else if (state.lastFinal?.source && state.lastFinal.translation) {
    const item = state.lastFinal;
    state.lastFinal = {
      id: ++utteranceSerial,
      source: item.translation,
      translation: item.source,
      sourceLang: item.targetLang || currentSource(),
      targetLang: item.sourceLang || currentTarget(),
    };
  } else {
    state.interim = '';
    state.interimTranslation = '';
  }

  restartListenerSoon();
  render();
}

swapBtn.addEventListener('click', exchangeLanguages);

mic.addEventListener('click', toggleMic);

autoSpeak.addEventListener('change', () => {
  savePrefs();
});

copyBtn.addEventListener('click', async () => {
  const text = currentView()?.translation;
  if (!text) return;
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    const area = document.createElement('textarea');
    area.value = text;
    document.body.append(area);
    area.select();
    try { document.execCommand('copy'); } catch { /* 瀏覽器不允許寫入剪貼簿 */ }
    area.remove();
  }
  copyBtn.textContent = '已複製';
  setTimeout(() => {
    copyBtn.textContent = '複製譯文';
  }, 1400);
});

clearBtn.addEventListener('click', () => {
  state.history = [];
  render();
});

historyEl.addEventListener('click', (event) => {
  const button = event.target.closest('[data-speak]');
  if (!button) return;
  const item = state.history[Number(button.dataset.speak)];
  if (!item?.translation) return;
  enqueue(() => withMicPaused(() => speakText(item.translation, item.targetTts)));
});

document.addEventListener('keydown', (event) => {
  const tag = document.activeElement?.tagName;
  if (event.code === 'Escape') {
    if (tag === 'INPUT' || tag === 'TEXTAREA') document.activeElement.blur();
    if (state.session || state.speaking) stopSession();
    return;
  }
  if (event.code !== 'Space' || event.repeat) return;
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || tag === 'BUTTON' || tag === 'A') return;
  if (!rec) return;
  event.preventDefault();
  toggleMic();
});

window.speechSynthesis?.getVoices();
window.speechSynthesis?.addEventListener('voiceschanged', () => {
  window.speechSynthesis.getVoices();
});

render();

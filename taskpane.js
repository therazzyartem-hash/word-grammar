'use strict';

// Бесплатный публичный API LanguageTool: ~20 запросов/мин, ~20 КБ на запрос, ~75 КБ/мин
const LT_URL = 'https://api.languagetool.org/v2/check';
const POLL_MS = 2500;          // как часто смотрим документ
const MAX_CHUNK = 8000;        // символов в одном запросе (кириллица = 2 байта)
const MAX_REQ_PER_MIN = 18;
const MAX_CHARS_PER_MIN = 35000;
const RETRY_FAILED_MS = 60000;

const state = {
  paras: [],            // тексты абзацев документа на последнем опросе
  prevTexts: [],        // то же на предыдущем опросе — для «абзац перестал меняться»
  cache: new Map(),     // текст абзаца -> найденные ошибки
  pending: new Set(),   // тексты в очереди на проверку
  failed: new Map(),    // текст -> время ошибки запроса
  dismissed: new Set(), // «не ошибка» для конкретного места
  ignored: new Set(),   // словарь
  expanded: new Set(),  // раскрытые карточки (по тексту абзаца)
  lang: 'ru-RU',
  auto: true,
  track: false,
  busy: false,          // идёт правка документа — опрос на паузе
  firstPoll: true,
  lastRender: '',
};

const $ = id => document.getElementById(id);
const sleep = ms => new Promise(r => setTimeout(r, ms));
const esc = s => s.replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const plural = (n, one, few, many) => {
  const m10 = n % 10, m100 = n % 100;
  if (m10 === 1 && m100 !== 11) return one;
  if (m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14)) return few;
  return many;
};

// ---------- настройки (хранятся внутри документа) ----------

function loadSettings() {
  const s = Office.context.document.settings;
  state.ignored = new Set(s.get('korrektor.ignored') || []);
  state.lang = s.get('korrektor.lang') || 'ru-RU';
  state.track = !!s.get('korrektor.track');
  $('lang').value = state.lang;
  $('track').checked = state.track;
}

function saveSettings() {
  const s = Office.context.document.settings;
  s.set('korrektor.ignored', [...state.ignored]);
  s.set('korrektor.lang', state.lang);
  s.set('korrektor.track', state.track);
  s.set('Office.AutoShowTaskpaneWithDocument', true); // панель сама откроется с документом
  s.saveAsync();
}

// ---------- ошибки абзаца ----------

function isSpelling(m) {
  return m.category === 'TYPOS' || /MORFOLOGIK|SPELL/i.test(m.rule);
}

function visibleMatches(text) {
  const ms = state.cache.get(text);
  if (!ms) return [];
  return ms.filter(m =>
    !state.dismissed.has(text + '|' + m.offset + '|' + m.rule) &&
    !(isSpelling(m) && state.ignored.has(m.bad.toLowerCase())));
}

// «Опечатка» в слове с заглавной не в начале предложения — скорее всего имя: сами не правим
function isLikelyName(m, text) {
  if (!isSpelling(m) || !/^[A-ZА-ЯЁ]/.test(m.bad)) return false;
  const before = text.slice(0, m.offset).trimEnd();
  return before.length > 0 && !/[.!?…«"—–-]$/.test(before);
}

// Ошибки, которые можно исправить автоматически: есть вариант, не имя, не пересекаются
function fixableMatches(text) {
  const ms = visibleMatches(text).filter(m => m.repl.length && m.bad.length <= 255 && m.auto !== false && !isLikelyName(m, text))
    .sort((a, b) => b.offset - a.offset);
  const out = [];
  let limit = Infinity;
  for (const m of ms) {
    if (m.offset + m.length <= limit) { out.push(m); limit = m.offset; }
  }
  return out; // с конца абзаца к началу — так смещения не съезжают
}

// Какой по счёту результат поиска Word соответствует ошибке
function occurrenceIndex(text, needle, offset) {
  let pos = 0, n = 0;
  for (;;) {
    const i = text.indexOf(needle, pos);
    if (i < 0 || i > offset) return -1;
    if (i === offset) return n;
    n++; pos = i + needle.length;
  }
}

const searchText = s => s.replace(/\^/g, '^^'); // ^ — спецсимвол в поиске Word

// ---------- LanguageTool ----------

const queue = [];
const history = [];
let pumping = false;

function enqueue(texts) {
  for (const t of texts) { state.pending.add(t); queue.push(t); }
  pump();
}

async function waitForQuota(chars) {
  for (;;) {
    const now = Date.now();
    while (history.length && now - history[0].t > 60000) history.shift();
    const used = history.reduce((s, h) => s + h.chars, 0);
    if (!history.length || (history.length < MAX_REQ_PER_MIN && used + chars <= MAX_CHARS_PER_MIN)) {
      history.push({ t: now, chars });
      return;
    }
    setStatus('Пауза — лимит бесплатной проверки, продолжу через минуту…');
    await sleep(1000);
  }
}

async function ltCheck(text) {
  for (let attempt = 0; attempt < 3; attempt++) {
    const body = new URLSearchParams({ text, language: state.lang, level: 'default' });
    const r = await fetch(LT_URL, { method: 'POST', body });
    if (r.status === 429) { setStatus('Сервер просит подождать…'); await sleep(20000); continue; }
    if (!r.ok) throw new Error('сервер проверки ответил ' + r.status);
    return (await r.json()).matches || [];
  }
  throw new Error('сервер проверки перегружен');
}

async function pump() {
  if (pumping) return;
  pumping = true;
  try {
    while (queue.length) {
      const current = new Set(state.paras);
      const batch = [];
      let len = 0;
      while (queue.length && (!batch.length || len + queue[0].length + 2 <= MAX_CHUNK)) {
        const t = queue.shift();
        if (!current.has(t)) { state.pending.delete(t); continue; } // абзац уже изменился
        batch.push(t); len += t.length + 2;
      }
      if (!batch.length) continue;

      await waitForQuota(len);
      updateStatus();
      try {
        const matches = await ltCheck(batch.join('\n\n'));
        distribute(batch, matches);
        showError('');
      } catch (e) {
        for (const t of batch) state.failed.set(t, Date.now());
        showError('Не удалось проверить: ' + e.message + '. Повторю позже.');
      }
      for (const t of batch) state.pending.delete(t);
      render();
    }
  } finally {
    pumping = false;
  }
}

const PUNCT_CATEGORIES = ['PUNCTUATION', 'TYPOGRAPHY'];
const overlaps = (a, b) => a.offset < b.offset + b.length && b.offset < a.offset + a.length;

// Добавляем свои правила пунктуации (punctuation.js). При пересечении:
// пунктуацию LanguageTool заменяем своей, а орфография LanguageTool важнее нашей запятой
function mergeLocal(text, ltMatches) {
  const local = checkPunctuation(text);
  const lt = ltMatches.filter(m => !(PUNCT_CATEGORIES.includes(m.category) && local.some(l => overlaps(l, m))));
  const mine = local.filter(l => !lt.some(m => overlaps(l, m)));
  return [...lt, ...mine].sort((a, b) => a.offset - b.offset);
}

// Раскладываем ошибки из общего запроса по абзацам
function distribute(batch, matches) {
  const starts = [];
  let pos = 0;
  for (const t of batch) { starts.push(pos); pos += t.length + 2; }
  const per = batch.map(() => []);
  for (const m of matches) {
    let j = starts.length - 1;
    while (j > 0 && starts[j] > m.offset) j--;
    const t = batch[j], off = m.offset - starts[j];
    if (off + m.length > t.length) continue; // ошибка на стыке абзацев
    per[j].push({
      offset: off,
      length: m.length,
      bad: t.substr(off, m.length),
      message: m.message,
      repl: (m.replacements || []).slice(0, 4).map(r => r.value),
      rule: m.rule ? m.rule.id : '',
      category: m.rule && m.rule.category ? m.rule.category.id : '',
    });
  }
  batch.forEach((t, j) => state.cache.set(t, state.lang === 'en-US' ? per[j] : mergeLocal(t, per[j])));
}

// ---------- опрос документа ----------

async function poll() {
  if (state.busy) return;
  try {
    await Word.run(async ctx => {
      const ps = ctx.document.body.paragraphs;
      ps.load('items/text');
      await ctx.sync();
      const texts = ps.items.map(p => p.text);
      const now = Date.now();
      const toCheck = [];
      const seen = new Set();
      texts.forEach((t, i) => {
        if (!t.trim() || seen.has(t)) return;
        seen.add(t);
        if (state.cache.has(t) || state.pending.has(t)) return;
        if (now - (state.failed.get(t) || 0) < RETRY_FAILED_MS) return;
        // абзац проверяем, когда он не менялся с прошлого опроса — значит, человек его дописал
        if (state.firstPoll || state.prevTexts[i] === t) toCheck.push(t);
      });
      state.prevTexts = texts;
      state.paras = texts;
      state.firstPoll = false;
      if (state.auto || toCheck.length && state.forceCheck) enqueue(toCheck);
      state.forceCheck = false;
    });
  } catch (e) {
    showError('Не получилось прочитать документ: ' + e.message);
  }
  render();
}

async function loop() {
  for (;;) {
    await poll();
    await sleep(POLL_MS);
  }
}

// ---------- правка документа ----------

// targets: [{ index, matches: [{m, repl}] }]
async function applyFixes(targets) {
  if (!targets.length) return;
  state.busy = true;
  let fixed = 0, skipped = 0;
  try {
    await Word.run(async ctx => {
      const doc = ctx.document;
      if (state.track && Office.context.requirements.isSetSupported('WordApi', '1.4')) {
        doc.changeTrackingMode = Word.ChangeTrackingMode.trackAll;
      }
      const ps = doc.body.paragraphs;
      ps.load('items/text');
      await ctx.sync();

      const jobs = [];
      for (const { index, text, matches } of targets) {
        const p = ps.items[index];
        if (!p || p.text !== text) { skipped += matches.length; continue; } // абзац успели поменять
        for (const { m, repl } of matches) {
          const occ = occurrenceIndex(text, m.bad, m.offset);
          if (occ < 0) { skipped++; continue; }
          const res = p.search(searchText(m.bad), { matchCase: true, matchWildcards: false });
          res.load('items/text');
          jobs.push({ res, occ, m, repl });
        }
      }
      await ctx.sync();
      for (const j of jobs) {
        const r = j.res.items[j.occ];
        if (r && r.text === j.m.bad) { r.insertText(j.repl, 'Replace'); fixed++; }
        else skipped++;
      }
      await ctx.sync();
    });
    setStatus(`Исправлено: ${fixed}` + (skipped ? `, пропущено: ${skipped} (текст изменился — перепроверю)` : ''));
  } catch (e) {
    showError('Не получилось исправить: ' + e.message);
  } finally {
    state.busy = false;
  }
  state.firstPoll = true; // исправленные абзацы сразу перепроверить
  await poll();
}

function targetsFor(indices) {
  const out = [];
  for (const i of indices) {
    const text = state.paras[i];
    const ms = fixableMatches(text);
    if (ms.length) out.push({ index: i, text, matches: ms.map(m => ({ m, repl: m.repl[0] })) });
  }
  return out;
}

async function selectMatch(index, m) {
  try {
    await Word.run(async ctx => {
      const ps = ctx.document.body.paragraphs;
      ps.load('items/text');
      await ctx.sync();
      const p = ps.items[index];
      if (!p) return;
      const res = p.search(searchText(m.bad), { matchCase: true });
      res.load('items');
      await ctx.sync();
      const occ = occurrenceIndex(p.text, m.bad, m.offset);
      const r = res.items[occ < 0 ? 0 : occ];
      if (r) r.select();
      await ctx.sync();
    });
  } catch (e) {
    showError('Не получилось показать: ' + e.message);
  }
}

// ---------- интерфейс ----------

function setStatus(s) { $('status').textContent = s; }
function showError(s) { $('error').hidden = !s; $('error').textContent = s; }

function updateStatus() {
  const nonEmpty = new Set(state.paras.filter(t => t.trim()));
  const done = [...nonEmpty].filter(t => state.cache.has(t)).length;
  if (!state.auto && done < nonEmpty.size) setStatus(`Проверка на лету выключена. Проверено ${done} из ${nonEmpty.size}`);
  else if (done < nonEmpty.size) setStatus(`Проверяю… ${done} из ${nonEmpty.size} абзацев`);
  else setStatus(nonEmpty.size ? `Проверены все абзацы (${nonEmpty.size})` : 'Документ пуст');
}

function render() {
  const rows = [];
  let total = 0, fixable = 0;
  state.paras.forEach((text, index) => {
    const ms = visibleMatches(text);
    if (!ms.length) return;
    total += ms.length;
    fixable += fixableMatches(text).length;
    rows.push({ index, text, ms });
  });

  const key = JSON.stringify([rows.map(r => [r.index, r.text, r.ms.length]), [...state.expanded], total, state.busy]);
  updateStatus();
  if (key === state.lastRender) return;
  state.lastRender = key;

  const totalEl = $('total');
  totalEl.className = 'total ' + (total ? 'has' : 'ok');
  totalEl.textContent = total
    ? `${total} ${plural(total, 'ошибка', 'ошибки', 'ошибок')} в ${rows.length} ${plural(rows.length, 'абзаце', 'абзацах', 'абзацах')}`
    : 'Ошибок не найдено';
  const fixAll = $('fixAll');
  fixAll.disabled = !fixable || state.busy;
  fixAll.textContent = fixable ? `Исправить все (${fixable})` : 'Исправить все';

  const list = $('list');
  if (!rows.length) { list.innerHTML = ''; return; }
  list.innerHTML = rows.map(({ index, text, ms }) => {
    const open = state.expanded.has(text);
    const nFix = fixableMatches(text).length;
    const body = !open ? '' : `<div class="card-body">${ms.map((m, k) => `
      <div class="match">
        <div class="fixline">
          <span class="bad">${esc(m.bad)}</span>
          ${m.repl.length ? '<span class="arrow">→</span>' + m.repl.map((r, ri) =>
            `<button class="sugg" data-act="one" data-i="${index}" data-k="${k}" data-r="${ri}">${esc(r) || '(удалить)'}</button>`).join('') : ''}
        </div>
        <div class="msg">${esc(m.message)}${isLikelyName(m, text) ? ' Похоже на имя — сам не исправляю: выбери вариант или добавь в словарь.' : ''}</div>
        <div class="acts">
          <button data-act="show" data-i="${index}" data-k="${k}">Показать</button>
          <button data-act="dismiss" data-i="${index}" data-k="${k}">Не ошибка</button>
          ${isSpelling(m) ? `<button data-act="dict" data-i="${index}" data-k="${k}">В словарь</button>` : ''}
        </div>
      </div>`).join('')}</div>`;
    return `<div class="card">
      <div class="card-head" data-act="toggle" data-i="${index}">
        <span class="badge">${ms.length}</span>
        <div class="card-text">
          <div class="card-title">Абзац ${index + 1} · ${ms.length} ${plural(ms.length, 'ошибка', 'ошибки', 'ошибок')}</div>
          <div class="preview">${esc(text.slice(0, 90))}</div>
        </div>
        ${nFix ? `<button data-act="fixPara" data-i="${index}" ${state.busy ? 'disabled' : ''}>Исправить</button>` : ''}
      </div>${body}</div>`;
  }).join('');
}

function onListClick(e) {
  const el = e.target.closest('[data-act]');
  if (!el) return;
  const act = el.dataset.act;
  const index = +el.dataset.i;
  const text = state.paras[index];
  const m = el.dataset.k != null ? visibleMatches(text)[+el.dataset.k] : null;
  if (act !== 'toggle') e.stopPropagation();

  if (act === 'toggle') {
    state.expanded.has(text) ? state.expanded.delete(text) : state.expanded.add(text);
    render();
  } else if (act === 'fixPara') {
    applyFixes(targetsFor([index]));
  } else if (act === 'one' && m) {
    applyFixes([{ index, text, matches: [{ m, repl: m.repl[+el.dataset.r] }] }]);
  } else if (act === 'show' && m) {
    selectMatch(index, m);
  } else if (act === 'dismiss' && m) {
    state.dismissed.add(text + '|' + m.offset + '|' + m.rule);
    render();
  } else if (act === 'dict' && m) {
    addToDict(m.bad);
  }
}

function addToDict(word) {
  word = word.trim().toLowerCase();
  if (!word) return;
  state.ignored.add(word);
  saveSettings();
  renderDict();
  state.lastRender = '';
  render();
}

function renderDict() {
  const words = [...state.ignored].sort();
  $('dict').innerHTML = words.length
    ? words.map(w => `<span class="chip">${esc(w)}<button data-w="${esc(w)}" title="Убрать">×</button></span>`).join('')
    : '<span class="msg">пусто</span>';
}

function resetChecks() {
  state.cache.clear();
  state.failed.clear();
  state.dismissed.clear();
  state.firstPoll = true;
  state.forceCheck = true;
  state.lastRender = '';
  poll();
}

function init() {
  loadSettings();
  saveSettings();
  renderDict();

  $('list').addEventListener('click', onListClick);
  $('fixAll').addEventListener('click', () => applyFixes(targetsFor(state.paras.map((_, i) => i))));
  $('auto').addEventListener('change', e => {
    state.auto = e.target.checked;
    if (state.auto) { state.firstPoll = true; poll(); }
    updateStatus();
  });
  $('lang').addEventListener('change', e => { state.lang = e.target.value; saveSettings(); resetChecks(); });
  $('track').addEventListener('change', e => { state.track = e.target.checked; saveSettings(); });
  $('recheck').addEventListener('click', resetChecks);
  $('dict').addEventListener('click', e => {
    const w = e.target.dataset.w;
    if (w == null) return;
    state.ignored.delete(w);
    saveSettings(); renderDict(); state.lastRender = ''; render();
  });
  $('dictForm').addEventListener('submit', e => {
    e.preventDefault();
    addToDict($('dictInput').value);
    $('dictInput').value = '';
  });

  loop();
}

Office.onReady(info => {
  if (info.host === Office.HostType.Word) init();
  else $('total').textContent = 'Открой эту панель внутри Word.';
});

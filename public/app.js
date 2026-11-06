'use strict';

const els = {
  input: document.getElementById('input'),
  inputCount: document.getElementById('inputCount'),
  parseBtn: document.getElementById('parseBtn'),
  clearBtn: document.getElementById('clearBtn'),
  prefGroup: document.getElementById('prefGroup'),
  cards: document.getElementById('cards'),
  empty: document.getElementById('empty'),
  resultsMeta: document.getElementById('resultsMeta'),
  resultCount: document.getElementById('resultCount'),
  loginPill: document.getElementById('loginPill'),
  loginDot: document.getElementById('loginDot'),
  loginText: document.getElementById('loginText'),
  settingsBtn: document.getElementById('settingsBtn'),
  modal: document.getElementById('settingsModal'),
  modalClose: document.getElementById('modalClose'),
  sessdata: document.getElementById('sessdata'),
  saveSettings: document.getElementById('saveSettings'),
  logoutBtn: document.getElementById('logoutBtn'),
  qrToggle: document.getElementById('qrToggle'),
  qrBox: document.getElementById('qrBox'),
  qrImg: document.getElementById('qrImg'),
  qrStatus: document.getElementById('qrStatus'),
  qrRefresh: document.getElementById('qrRefresh'),
  ffmpegState: document.getElementById('ffmpegState'),
  toast: document.getElementById('toast')
};

const state = {
  pref: localStorage.getItem('wubli.pref') || 'max',
  loggedIn: false,
  parsing: false,
  uid: 0,
  cards: new Map()
};

const PREF_TARGETS = {
  '1080': [80, 112, 116],
  '720': [64, 74],
  '480': [32]
};

// ---------- 基础工具 ----------

async function api(url, options = {}) {
  const res = await fetch(url, {
    headers: { 'Content-Type': 'application/json' },
    ...options
  });
  const json = await res.json().catch(() => ({ ok: false, message: `请求失败（HTTP ${res.status}）` }));
  if (!res.ok || json.ok === false) throw new Error(json.message || `请求失败（HTTP ${res.status}）`);
  return json;
}

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function fmtBytes(n) {
  if (!n) return '未知';
  const units = ['B', 'KB', 'MB', 'GB'];
  let value = Number(n);
  let i = 0;
  while (value >= 1024 && i < units.length - 1) {
    value /= 1024;
    i++;
  }
  return `${value >= 100 || i === 0 ? Math.round(value) : value.toFixed(1)} ${units[i]}`;
}

function fmtDuration(sec) {
  const s = Math.max(0, Math.round(Number(sec) || 0));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const r = s % 60;
  if (h > 0) return `${h}:${String(m).padStart(2, '0')}:${String(r).padStart(2, '0')}`;
  return `${m}:${String(r).padStart(2, '0')}`;
}

function countTokens(text) {
  return String(text || '').split(/[\s,，、;；]+/).filter(Boolean).length;
}

let toastTimer = null;
function toast(message, isError = false) {
  els.toast.textContent = message;
  els.toast.classList.toggle('error', isError);
  els.toast.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => els.toast.classList.remove('show'), 3200);
}

function pickQuality(qualities, pref) {
  if (!qualities.length) return null;
  if (pref === 'max') return qualities[0];
  for (const target of PREF_TARGETS[pref] || []) {
    const hit = qualities.find((q) => q.qn === target);
    if (hit) return hit;
  }
  return qualities[0];
}

// ---------- 界面状态 ----------

function updateInputCount() {
  const n = countTokens(els.input.value);
  els.inputCount.textContent = `${n} 条`;
  els.inputCount.style.color = n > 20 ? '#ff9db0' : '';
}

function setParsing(on) {
  state.parsing = on;
  els.parseBtn.disabled = on;
  els.parseBtn.classList.toggle('loading', on);
  els.parseBtn.querySelector('.btn-label').textContent = on ? '解析中…' : '开始解析';
}

function updateSummary() {
  const okCount = state.cards.size;
  const failCount = els.cards.querySelectorAll('.error-card').length;
  const total = okCount + failCount;

  els.resultCount.hidden = total === 0;
  els.resultCount.textContent = String(okCount || total);

  const parts = [];
  if (okCount) parts.push(`${okCount} 个视频已解析`);
  if (failCount) parts.push(`${failCount} 条失败`);
  els.resultsMeta.textContent = parts.join(' · ');
  els.empty.hidden = total > 0;
}

function showSkeletons(count) {
  state.cards.clear();
  const n = Math.min(Math.max(count, 1), 6);
  els.cards.innerHTML = Array.from({ length: n }, () => `
    <div class="skeleton">
      <div class="sk-cover"></div>
      <div class="sk-line"></div>
      <div class="sk-line short"></div>
    </div>
  `).join('');
  els.empty.hidden = true;
}

// ---------- 渲染 ----------

function renderCard(item, index) {
  const id = `card-${state.uid++}`;
  const el = document.createElement('article');
  el.className = 'card';
  el.dataset.id = id;
  el.style.animationDelay = `${Math.min(index, 8) * 45}ms`;

  const pages = item.pages;
  const pageOptions = pages
    .map((p, i) => `<option value="${i}" ${i === item.defaultPage - 1 ? 'selected' : ''}>P${p.page} · ${escapeHtml(p.part)}</option>`)
    .join('');

  el.innerHTML = `
    <div class="cover">
      <img src="${escapeHtml(item.cover)}" alt="${escapeHtml(item.title)}" loading="lazy" referrerpolicy="no-referrer" />
      <span class="dur">${fmtDuration(item.pages[item.defaultPage - 1]?.duration || item.duration)}</span>
    </div>
    <div class="card-body">
      <h3 class="title" title="${escapeHtml(item.title)}">${escapeHtml(item.title)}</h3>
      <div class="meta-row">
        <span class="author">${escapeHtml(item.author)}</span>
        <span class="sep">·</span>
        <span class="bvid">${escapeHtml(item.bvid)}</span>
      </div>
      <div class="selectors">
        ${pages.length > 1 ? `<div class="select-wrap page"><select class="page-select" aria-label="选择分P">${pageOptions}</select></div>` : ''}
        <div class="select-wrap grow">
          <select class="quality-select" aria-label="选择画质" disabled><option>获取画质中…</option></select>
        </div>
      </div>
      <button class="login-tip" type="button" hidden>登录后可解锁更高画质 →</button>
      <div class="progress-block">
        <div class="progress-text"><span class="bytes"></span><span class="pct"></span></div>
        <div class="bar"><div class="bar-fill"></div></div>
      </div>
      <div class="card-foot">
        <span class="size-hint"></span>
        <button class="download-btn" type="button" disabled>
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <path d="M12 4v11M7 10l5 5 5-5M5 20h14"/>
          </svg>
          <span class="dl-label">下载 MP4</span>
        </button>
      </div>
    </div>
  `;

  const img = el.querySelector('.cover img');
  img.addEventListener('load', () => img.classList.add('loaded'));
  img.addEventListener('error', () => {
    img.remove();
    el.querySelector('.cover').style.background =
      'linear-gradient(135deg, rgba(251,114,153,.18), rgba(56,189,248,.14))';
  });

  const card = {
    id,
    item,
    el,
    pageIndex: item.defaultPage - 1,
    qualities: [],
    selectedQn: 0,
    controller: null
  };
  state.cards.set(id, card);
  els.cards.appendChild(el);
  loadQualities(card);
}

function renderError(item, index) {
  const el = document.createElement('article');
  el.className = 'error-card';
  el.style.animationDelay = `${Math.min(index, 8) * 45}ms`;
  el.innerHTML = `
    <div class="error-head">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
        <circle cx="12" cy="12" r="9"/><path d="M12 8v5M12 16h.01"/>
      </svg>
      解析失败
    </div>
    <div class="error-input" title="${escapeHtml(item.input || '')}">${escapeHtml(item.input || '未知输入')}</div>
    <div class="error-msg">${escapeHtml(item.error || '未知错误')}</div>
    <button class="error-remove" type="button">移除</button>
  `;
  els.cards.appendChild(el);
}

function qualityLabel(q) {
  const res = q.width && q.height ? `${q.width}×${q.height}` : '';
  return res ? `${q.label} · ${res}` : q.label;
}

function updateSizeHint(card) {
  const q = card.qualities.find((x) => x.qn === card.selectedQn);
  const hint = card.el.querySelector('.size-hint');
  hint.textContent = q ? (q.bytes ? `约 ${fmtBytes(q.bytes)}` : '大小未知') : '';
}

async function loadQualities(card) {
  const qSelect = card.el.querySelector('.quality-select');
  const dlBtn = card.el.querySelector('.download-btn');
  const tip = card.el.querySelector('.login-tip');
  const page = card.item.pages[card.pageIndex];

  card.qualities = [];
  qSelect.disabled = true;
  qSelect.innerHTML = '<option>获取画质中…</option>';
  dlBtn.disabled = true;
  tip.hidden = true;

  const durEl = card.el.querySelector('.dur');
  if (durEl) durEl.textContent = fmtDuration(page.duration || card.item.duration);

  try {
    const data = await api(`/api/qualities?bvid=${encodeURIComponent(card.item.bvid)}&cid=${page.cid}`);
    if (!data.qualities || !data.qualities.length) throw new Error('该视频没有可用画质');

    card.qualities = data.qualities;
    const chosen = pickQuality(data.qualities, state.pref);
    card.selectedQn = chosen.qn;

    qSelect.innerHTML = data.qualities
      .map((q) => `<option value="${q.qn}" ${q.qn === chosen.qn ? 'selected' : ''}>${escapeHtml(qualityLabel(q))}</option>`)
      .join('');
    qSelect.disabled = false;
    dlBtn.disabled = false;
    updateSizeHint(card);

    if (data.needLogin && !state.loggedIn) tip.hidden = false;
  } catch (err) {
    card.qualities = [];
    qSelect.innerHTML = '<option>画质获取失败</option>';
    card.el.querySelector('.size-hint').textContent = err.message;
  }
}

// ---------- 下载 ----------

function setProgress(card, received, total, done = false) {
  const fill = card.el.querySelector('.bar-fill');
  const bytesEl = card.el.querySelector('.bytes');
  const pctEl = card.el.querySelector('.pct');
  const pct = total ? Math.min(100, (received / total) * 100) : 0;

  if (total) {
    fill.style.width = `${done ? 100 : Math.min(pct, 99.9)}%`;
    pctEl.textContent = done ? '100%' : `${Math.floor(pct)}%`;
    bytesEl.textContent = `${fmtBytes(received)} / 约 ${fmtBytes(total)}`;
  } else {
    fill.style.width = done ? '100%' : '30%';
    pctEl.textContent = done ? '完成' : '下载中';
    bytesEl.textContent = fmtBytes(received);
  }
}

function filenameFromHeader(header, fallback) {
  if (header) {
    const star = header.match(/filename\*=UTF-8''([^;]+)/i);
    if (star) {
      try {
        return decodeURIComponent(star[1]);
      } catch {}
    }
    const plain = header.match(/filename="([^"]+)"/i);
    if (plain) return plain[1];
  }
  return `${fallback}.mp4`;
}

// 预览代理无法处理 URL 中的中文字符（即使已百分号编码），这里用 Base64URL 传递文件名
function encodeName(str) {
  let bin = '';
  for (const byte of new TextEncoder().encode(str)) bin += String.fromCharCode(byte);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function saveBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}

function resetDownloadUI(card) {
  const block = card.el.querySelector('.progress-block');
  const btn = card.el.querySelector('.download-btn');
  const label = btn.querySelector('.dl-label');
  const qSelect = card.el.querySelector('.quality-select');
  const pageSelect = card.el.querySelector('.page-select');

  block.classList.remove('show');
  card.el.querySelector('.bar-fill').style.width = '0%';
  btn.disabled = false;
  if (label) label.textContent = '下载 MP4';
  if (qSelect) qSelect.disabled = false;
  if (pageSelect) pageSelect.disabled = false;
}

const DOWNLOAD_CONNECTIONS = 8;

async function downloadParallel(url, total, signal, card) {
  const chunk = Math.ceil(total / DOWNLOAD_CONNECTIONS);
  const parts = [];
  let received = 0;
  const jobs = [];

  for (let i = 0; i < DOWNLOAD_CONNECTIONS; i++) {
    const start = i * chunk;
    if (start >= total) break;
    const end = Math.min(total - 1, start + chunk - 1);
    jobs.push((async () => {
      const res = await fetch(url, {
        headers: { Range: `bytes=${start}-${end}` },
        signal
      });
      if (res.status !== 206) throw new Error(`分片下载失败（HTTP ${res.status}）`);
      if (!res.body) throw new Error('当前浏览器不支持流式下载');
      const reader = res.body.getReader();
      const buf = [];
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buf.push(value);
        received += value.length;
        setProgress(card, received, total);
      }
      parts[i] = new Blob(buf, { type: 'video/mp4' });
    })());
  }

  await Promise.all(jobs);
  const blob = new Blob(parts, { type: 'video/mp4' });
  if (blob.size !== total) throw new Error('下载数据不完整，请重试');
  return blob;
}

async function readStream(res, card, estimate) {
  if (!res.body) throw new Error('当前浏览器不支持流式下载');
  const reader = res.body.getReader();
  const chunks = [];
  let received = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    received += value.length;
    setProgress(card, received, estimate);
  }
  if (!received) throw new Error('未获取到视频数据');
  return { blob: new Blob(chunks, { type: 'video/mp4' }), size: received };
}

async function download(card) {
  if (card.controller) {
    card.controller.abort();
    return;
  }

  const page = card.item.pages[card.pageIndex];
  const quality = card.qualities.find((q) => q.qn === card.selectedQn);
  if (!quality) {
    toast('请先选择画质', true);
    return;
  }

  const block = card.el.querySelector('.progress-block');
  const btn = card.el.querySelector('.download-btn');
  const label = btn.querySelector('.dl-label');
  const qSelect = card.el.querySelector('.quality-select');
  const pageSelect = card.el.querySelector('.page-select');

  const name = card.item.title + (card.item.pages.length > 1 ? ` P${page.page}` : '');
  const estimate = quality.bytes || 0;

  block.classList.add('show');
  setProgress(card, 0, estimate);
  btn.disabled = false;
  label.textContent = '取消下载';
  if (qSelect) qSelect.disabled = true;
  if (pageSelect) pageSelect.disabled = true;

  const controller = new AbortController();
  card.controller = controller;

  try {
    const url =
      `/api/download?bvid=${encodeURIComponent(card.item.bvid)}&cid=${page.cid}` +
      `&qn=${card.selectedQn}&fn=${encodeName(name)}`;

    // 用 1 字节 Range 探测总大小并验证服务端支持分片。
    // 不用 HEAD：部分预览代理会破坏 HEAD 请求。
    let total = 0;
    let filename = `${name}.mp4`;
    let blob = null;

    let probe = null;
    try {
      probe = await fetch(url, { headers: { Range: 'bytes=0-0' }, signal: controller.signal });
    } catch (err) {
      if (err.name === 'AbortError') throw err;
    }

    if (probe && probe.status === 206) {
      const range = probe.headers.get('content-range') || '';
      const match = range.match(/\/(\d+)\s*$/);
      if (match) total = Number(match[1]);
      filename = filenameFromHeader(probe.headers.get('content-disposition'), name);
      await probe.arrayBuffer().catch(() => {});
    } else if (probe && probe.ok) {
      // 服务端没有按 Range 返回，这次响应就是完整文件，直接复用
      const streamed = await readStream(probe, card, estimate);
      blob = streamed.blob;
      total = streamed.size;
      filename = filenameFromHeader(probe.headers.get('content-disposition'), name);
    } else if (probe) {
      const payload = await probe.json().catch(() => null);
      throw new Error((payload && payload.message) || `下载失败（HTTP ${probe.status}）`);
    }

    if (!blob) {
      if (total > 1024 * 1024) {
        setProgress(card, 0, total);
        blob = await downloadParallel(url, total, controller.signal, card);
      } else {
        const res = await fetch(url, { signal: controller.signal });
        if (!res.ok) {
          const payload = await res.json().catch(() => null);
          throw new Error((payload && payload.message) || `下载失败（HTTP ${res.status}）`);
        }
        const streamed = await readStream(res, card, estimate);
        blob = streamed.blob;
        total = streamed.size;
        filename = filenameFromHeader(res.headers.get('content-disposition'), name);
      }
    }

    setProgress(card, total, total, true);
    saveBlob(blob, filename);
    label.textContent = '已下载';
    btn.disabled = true;
    setTimeout(() => resetDownloadUI(card), 2200);
  } catch (err) {
    const aborted = err.name === 'AbortError';
    if (aborted) {
      toast('已取消下载');
    } else {
      toast(`下载失败：${err.message}`, true);
    }
    resetDownloadUI(card);
  } finally {
    card.controller = null;
  }
}

// ---------- 解析 ----------

async function parse() {
  if (state.parsing) return;
  const text = els.input.value.trim();
  if (!text) {
    toast('请先粘贴视频链接或 BV 号', true);
    els.input.focus();
    return;
  }

  setParsing(true);
  els.resultsMeta.textContent = '正在解析…';
  showSkeletons(countTokens(text));

  try {
    const data = await api('/api/parse', {
      method: 'POST',
      body: JSON.stringify({ input: text })
    });

    els.cards.innerHTML = '';
    state.cards.clear();
    let okCount = 0;
    data.items.forEach((item, index) => {
      if (item.ok) {
        okCount++;
        renderCard(item, index);
      } else {
        renderError(item, index);
      }
    });

    updateSummary();
    if (!data.items.length) {
      els.resultsMeta.textContent = '';
      els.empty.hidden = false;
    }
    if (data.truncated) toast(`单次最多解析 20 条，已忽略 ${data.truncated} 条`);
  } catch (err) {
    els.cards.innerHTML = '';
    state.cards.clear();
    els.resultsMeta.textContent = '';
    els.empty.hidden = false;
    toast(err.message, true);
  } finally {
    setParsing(false);
  }
}

// ---------- 设置 / 登录 ----------

function updateLoginUI(uname) {
  els.loginDot.classList.toggle('on', state.loggedIn);
  els.loginText.textContent = state.loggedIn ? (uname ? `已登录 · ${uname}` : '已登录') : '游客模式';
}

async function refreshSettings() {
  try {
    const data = await fetch('/api/settings').then((r) => r.json());
    state.loggedIn = !!data.loggedIn;
    updateLoginUI();
    els.ffmpegState.textContent = data.hasFFmpeg ? 'ffmpeg 已就绪' : '未检测到 ffmpeg，将下载无声视频';
  } catch {
    els.ffmpegState.textContent = '';
  }
}

function openSettings() {
  els.modal.hidden = false;
  setTimeout(() => els.sessdata.focus(), 60);
}

function closeSettings() {
  els.modal.hidden = true;
  stopQrLogin();
}

// ---------- 扫码登录 ----------
let qrTimer = null;
let qrKey = '';
let qrFailCount = 0;

function stopQrLogin() {
  if (qrTimer) {
    clearInterval(qrTimer);
    qrTimer = null;
  }
}

async function startQrLogin() {
  els.qrBox.hidden = false;
  els.qrToggle.hidden = true;
  els.qrImg.removeAttribute('src');
  els.qrStatus.textContent = '正在获取二维码…';
  els.qrRefresh.hidden = true;
  stopQrLogin();
  qrFailCount = 0;
  try {
    const data = await api('/api/qrcode');
    qrKey = data.key;
    els.qrImg.src =
      'https://api.qrserver.com/v1/create-qr-code/?size=180x180&margin=8&data=' +
      encodeURIComponent(data.url);
    els.qrStatus.textContent = '打开手机「哔哩哔哩」App → 我的 → 扫一扫';
    qrTimer = setInterval(pollQr, 2000);
  } catch (err) {
    els.qrStatus.textContent = err.message;
    els.qrRefresh.hidden = false;
    els.qrRefresh.textContent = '重试';
  }
}

async function pollQr() {
  try {
    const d = await fetch(`/api/qrcode/poll?key=${encodeURIComponent(qrKey)}`).then((r) => r.json());
    qrFailCount = 0;
    if (d.ok && d.code === 0) {
      stopQrLogin();
      els.qrBox.hidden = true;
      els.qrToggle.hidden = false;
      state.loggedIn = true;
      closeSettings();
      toast('扫码登录成功');
      refreshSettings();
      state.cards.forEach((card) => {
        if (card.qualities.length) loadQualities(card);
      });
      return;
    }
    if (d.code === 86090) {
      els.qrStatus.textContent = '已扫码，请在手机上点「确认登录」';
    } else if (d.code === 86038) {
      stopQrLogin();
      els.qrStatus.textContent = '二维码已过期';
      els.qrRefresh.hidden = false;
      els.qrRefresh.textContent = '刷新二维码';
    } else if (!d.ok && d.message) {
      els.qrStatus.textContent = d.message;
    }
  } catch {
    qrFailCount++;
    if (qrFailCount >= 3) els.qrStatus.textContent = '网络异常，仍在重试…';
  }
}

async function saveSettings(value) {
  els.saveSettings.disabled = true;
  const label = els.saveSettings.querySelector('.btn-label');
  const original = label.textContent;
  label.textContent = '保存中…';

  try {
    const data = await api('/api/settings', {
      method: 'POST',
      body: JSON.stringify({ sessdata: value })
    });
    state.loggedIn = !!data.loggedIn;
    updateLoginUI(data.uname);
    toast(data.loggedIn ? `登录成功${data.uname ? `，欢迎 ${data.uname}` : ''}` : '已切换为游客模式');
    closeSettings();
    els.sessdata.value = '';
    state.cards.forEach((card) => {
      if (card.qualities.length) loadQualities(card);
    });
  } catch (err) {
    toast(err.message, true);
  } finally {
    els.saveSettings.disabled = false;
    label.textContent = original;
  }
}

// ---------- 事件绑定 ----------

els.input.addEventListener('input', updateInputCount);
els.input.addEventListener('keydown', (e) => {
  if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
    e.preventDefault();
    parse();
  }
});

els.parseBtn.addEventListener('click', parse);

els.clearBtn.addEventListener('click', () => {
  state.cards.forEach((card) => card.controller && card.controller.abort());
  els.input.value = '';
  els.cards.innerHTML = '';
  state.cards.clear();
  updateInputCount();
  updateSummary();
  els.resultsMeta.textContent = '';
  els.empty.hidden = false;
  els.input.focus();
});

els.prefGroup.addEventListener('click', (e) => {
  const btn = e.target.closest('button[data-pref]');
  if (!btn) return;
  state.pref = btn.dataset.pref;
  localStorage.setItem('wubli.pref', state.pref);
  els.prefGroup.querySelectorAll('button').forEach((b) => b.classList.toggle('active', b === btn));

  state.cards.forEach((card) => {
    if (!card.qualities.length) return;
    const chosen = pickQuality(card.qualities, state.pref);
    card.selectedQn = chosen.qn;
    const select = card.el.querySelector('.quality-select');
    if (select) select.value = String(chosen.qn);
    updateSizeHint(card);
  });
});

els.cards.addEventListener('change', (e) => {
  const cardEl = e.target.closest('.card');
  if (!cardEl) return;
  const card = state.cards.get(cardEl.dataset.id);
  if (!card) return;

  if (e.target.classList.contains('page-select')) {
    card.pageIndex = Number(e.target.value);
    loadQualities(card);
  } else if (e.target.classList.contains('quality-select')) {
    card.selectedQn = Number(e.target.value);
    updateSizeHint(card);
  }
});

els.cards.addEventListener('click', (e) => {
  const cardEl = e.target.closest('.card');
  const card = cardEl ? state.cards.get(cardEl.dataset.id) : null;

  if (e.target.closest('.download-btn') && card) {
    download(card);
    return;
  }
  if (e.target.closest('.login-tip')) {
    openSettings();
    return;
  }
  const removeBtn = e.target.closest('.error-remove');
  if (removeBtn) {
    removeBtn.closest('.error-card').remove();
    updateSummary();
  }
});

els.settingsBtn.addEventListener('click', openSettings);
els.loginPill.addEventListener('click', openSettings);
els.modalClose.addEventListener('click', closeSettings);
els.modal.addEventListener('click', (e) => {
  if (e.target === els.modal) closeSettings();
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && !els.modal.hidden) closeSettings();
});

function submitSessdata() {
  const value = els.sessdata.value.trim();
  if (!value) {
    toast('未填写 SESSDATA，未做任何修改；如要退出登录请点「退出登录」');
    return;
  }
  saveSettings(value);
}

els.saveSettings.addEventListener('click', submitSessdata);
els.sessdata.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') {
    e.preventDefault();
    submitSessdata();
  }
});
els.logoutBtn.addEventListener('click', () => saveSettings(''));
els.qrToggle.addEventListener('click', startQrLogin);
els.qrRefresh.addEventListener('click', startQrLogin);

// ---------- 初始化 ----------

const initialPrefBtn = els.prefGroup.querySelector(`button[data-pref="${state.pref}"]`);
if (initialPrefBtn) {
  els.prefGroup.querySelectorAll('button').forEach((b) => b.classList.toggle('active', b === initialPrefBtn));
}

updateInputCount();
updateSummary();
refreshSettings();

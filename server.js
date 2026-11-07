'use strict';

const express = require('express');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const fsp = require('node:fs/promises');
const { spawn, spawnSync } = require('node:child_process');

const app = express();
const PORT = Number(process.env.PORT) || 3200;
const MAX_BATCH = 20;

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const BILI_REFERER = 'https://www.bilibili.com/';

const QUALITY_LABELS = {
  127: '8K 超高清',
  126: '杜比视界',
  125: 'HDR 真彩',
  120: '4K 超清',
  116: '1080P 60帧',
  112: '1080P 高码率',
  80: '1080P 高清',
  74: '720P 60帧',
  64: '720P 高清',
  32: '480P 清晰',
  16: '360P 流畅',
  6: '240P 极速'
};

const CODE_MESSAGES = {
  '-400': 'B 站拒绝了请求，请稍后重试',
  '-401': '请求被拦截，请稍后重试',
  '-403': '没有访问权限，可能需要登录',
  '-404': '视频不存在或已被删除',
  '-104': '账号未登录',
  '-101': '账号未登录',
  62002: '该稿件不可见（可能已被 UP 主删除）',
  62004: '该稿件正在审核中',
  87007: '该视频仅大会员可观看'
};

// ---------- 会话状态（内存内，重启后重置） ----------
let sessdata = (process.env.BILI_SESSDATA || '').trim();
let cookieJar = {};
const FALLBACK_BUVID = process.env.BILI_BUVID3 || '';

function parseSetCookie(list) {
  const jar = {};
  for (const raw of list) {
    if (!raw) continue;
    const pair = raw.split(';')[0];
    const idx = pair.indexOf('=');
    if (idx <= 0) continue;
    jar[pair.slice(0, idx).trim()] = pair.slice(idx + 1);
  }
  return jar;
}

let cookiePromise = null;
async function ensureCookies(force = false) {
  if (cookieJar.buvid3 && !force) return;
  if (cookiePromise) {
    await cookiePromise;
    if (!force) return;
  }
  cookiePromise = (async () => {
    try {
      const res = await fetch('https://www.bilibili.com/', {
        headers: {
          'User-Agent': UA,
          Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
          'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8'
        },
        signal: AbortSignal.timeout(12000)
      });
      const list = res.headers.getSetCookie ? res.headers.getSetCookie() : [];
      const jar = parseSetCookie(list);
      if (jar.buvid3) cookieJar = jar;
    } catch {
      // 首页不可用时退回本地生成的 buvid3
    }
    if (!cookieJar.buvid3 && FALLBACK_BUVID) cookieJar = { buvid3: FALLBACK_BUVID };
  })().finally(() => {
    cookiePromise = null;
  });
  await cookiePromise;
}

// 优先使用随依赖安装的 ffmpeg 静态二进制，系统未安装 ffmpeg 时也能合并音视频
let ffmpegPath = 'ffmpeg';
try {
  const bundled = require('ffmpeg-static');
  if (bundled) ffmpegPath = bundled;
} catch {
  // 未安装 ffmpeg-static 时回退到系统 PATH 中的 ffmpeg
}
const hasFFmpeg = spawnSync(ffmpegPath, ['-version'], { stdio: 'ignore' }).status === 0;

class BiliError extends Error {
  constructor(code, message) {
    super(CODE_MESSAGES[String(code)] || message || 'B 站接口返回错误');
    this.code = code;
  }
}

function biliHeaders(extra) {
  const cookie = Object.entries(cookieJar).map(([k, v]) => `${k}=${v}`).join('; ');
  return {
    'User-Agent': UA,
    Referer: BILI_REFERER,
    Origin: 'https://www.bilibili.com',
    Accept: 'application/json, text/plain, */*',
    'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
    'sec-fetch-site': 'same-site',
    'sec-fetch-mode': 'cors',
    'sec-fetch-dest': 'empty',
    Cookie: sessdata ? `${cookie}; SESSDATA=${sessdata}` : cookie,
    ...extra
  };
}

async function biliGet(url, timeout = 15000) {
  await ensureCookies();
  let res = await fetch(url, {
    headers: biliHeaders(),
    signal: AbortSignal.timeout(timeout)
  });
  if (res.status === 412) {
    // 触发风控时换一份新的会话 Cookie 再试一次
    await ensureCookies(true);
    res = await fetch(url, {
      headers: biliHeaders(),
      signal: AbortSignal.timeout(timeout)
    });
  }
  if (res.status === 412) throw new BiliError(412, 'B 站触发风控，请稍后重试');
  if (!res.ok) throw new Error(`B 站接口异常（HTTP ${res.status}）`);
  const text = await res.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    throw new Error('B 站接口返回了非预期内容，请稍后再试');
  }
  if (json.code !== 0) throw new BiliError(json.code, json.message);
  return json.data;
}

// ---------- 链接归一化 ----------
function normalizeInput(input) {
  const chunks = String(input || '')
    .split(/[\s,，、;；]+/)
    .filter(Boolean);
  const seen = new Set();
  const tokens = [];

  for (const chunk of chunks) {
    let token = null;
    if (/b23\.tv|bili2233\.cn/i.test(chunk)) {
      token = { type: 'short', value: chunk, raw: chunk };
    } else {
      const p = chunk.match(/[?&]p=(\d+)/);
      const bv = chunk.match(/BV[0-9A-Za-z]{10}/);
      const av = chunk.match(/av(\d+)/i);
      if (bv) token = { type: 'bvid', value: bv[0], p: p ? Number(p[1]) : 1, raw: chunk };
      else if (av) token = { type: 'aid', value: Number(av[1]), p: p ? Number(p[1]) : 1, raw: chunk };
      else token = { type: 'invalid', value: chunk, raw: chunk };
    }
    const key = `${token.type}:${token.value}`.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    tokens.push(token);
  }
  return tokens;
}

async function resolveShortLink(url) {
  const target = url.startsWith('http') ? url : `https://${url}`;
  const res = await fetch(target, {
    redirect: 'manual',
    headers: { 'User-Agent': UA },
    signal: AbortSignal.timeout(10000)
  });
  const loc = res.headers.get('location') || '';
  const bv = loc.match(/BV[0-9A-Za-z]{10}/);
  if (bv) return { type: 'bvid', value: bv[0], p: 1, raw: url };
  const av = loc.match(/av(\d+)/i);
  if (av) return { type: 'aid', value: Number(av[1]), p: 1, raw: url };
  throw new Error('短链接解析失败，请直接粘贴完整视频链接');
}

function coverProxyUrl(raw) {
  if (!raw) return '';
  const url = raw.replace(/^http:/, 'https:');
  return `/api/cover?url=${encodeURIComponent(url)}`;
}

async function fetchVideoInfo(token) {
  const api = token.type === 'aid'
    ? `https://api.bilibili.com/x/web-interface/view?aid=${token.value}`
    : `https://api.bilibili.com/x/web-interface/view?bvid=${token.value}`;
  const data = await biliGet(api);

  const pages = (data.pages && data.pages.length)
    ? data.pages.map((p) => ({
        cid: p.cid,
        page: p.page,
        part: p.part || `P${p.page}`,
        duration: p.duration || 0
      }))
    : [{ cid: data.cid, page: 1, part: data.title, duration: data.duration || 0 }];

  return {
    bvid: data.bvid,
    aid: data.aid,
    title: data.title,
    cover: coverProxyUrl(data.pic),
    author: data.owner && data.owner.name ? data.owner.name : '未知 UP 主',
    duration: data.duration || 0,
    pubdate: data.pubdate || 0,
    desc: (data.desc || '').slice(0, 200),
    pages,
    defaultPage: Math.min(Math.max(token.p || 1, 1), pages.length)
  };
}

async function mapLimit(items, limit, fn) {
  const results = new Array(items.length);
  let cursor = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (cursor < items.length) {
      const index = cursor++;
      results[index] = await fn(items[index], index);
    }
  });
  await Promise.all(workers);
  return results;
}

// ---------- playurl ----------
const playurlCache = new Map();
const PLAYURL_TTL = 120 * 1000;

async function getPlayurl(bvid, cid) {
  const key = `${bvid}:${cid}`;
  const hit = playurlCache.get(key);
  if (hit && hit.expires > Date.now()) return hit.data;

  const data = await biliGet(
    'https://api.bilibili.com/x/player/playurl' +
    `?bvid=${encodeURIComponent(bvid)}&cid=${encodeURIComponent(cid)}` +
    '&qn=127&fnval=4048&fourk=1&platform=pc'
  );
  playurlCache.set(key, { data, expires: Date.now() + PLAYURL_TTL });
  if (playurlCache.size > 200) {
    for (const [k, v] of playurlCache) {
      if (v.expires <= Date.now()) playurlCache.delete(k);
    }
  }
  return data;
}

function pickAudio(audioList) {
  const list = audioList || [];
  if (!list.length) return null;
  const preferred = list.find((a) => a.id === 30280);
  if (preferred) return preferred;
  return list.slice().sort((a, b) => (b.bandwidth || 0) - (a.bandwidth || 0))[0];
}

function normalizePlayurl(data) {
  const duration = data.dash && data.dash.duration
    ? data.dash.duration
    : (data.timelength || 0) / 1000;
  const audio = pickAudio(data.dash && data.dash.audio);
  const maxAccepted = Math.max(...(data.accept_quality || [0]));
  let qualities = [];

  if (data.dash && data.dash.video && data.dash.video.length) {
    const groups = new Map();
    for (const v of data.dash.video) {
      const item = groups.get(v.id) || {
        qn: v.id,
        label: QUALITY_LABELS[v.id] || `${v.height}P`,
        width: v.width,
        height: v.height,
        fps: Number(v.frameRate) || 0,
        bandwidth: 0
      };
      item.bandwidth = Math.max(item.bandwidth, v.bandwidth || 0);
      item.width = Math.max(item.width, v.width || 0);
      item.height = Math.max(item.height, v.height || 0);
      if (Number(v.frameRate) > item.fps) item.fps = Number(v.frameRate);
      groups.set(v.id, item);
    }
    qualities = [...groups.values()]
      .map((q) => ({
        ...q,
        bytes: Math.round(((q.bandwidth + ((audio && audio.bandwidth) || 0)) / 8) * duration)
      }))
      .sort((a, b) => b.qn - a.qn);
  } else if (data.durl && data.durl.length) {
    qualities = [{
      qn: data.quality || 32,
      label: QUALITY_LABELS[data.quality] || `${data.quality || 32}`,
      width: 0,
      height: 0,
      fps: 0,
      bytes: 0
    }];
  }

  return {
    qualities,
    duration,
    needLogin: qualities.length > 0 && maxAccepted > Math.max(...qualities.map((q) => q.qn))
  };
}

function pickVideoStream(data, qn) {
  const videos = (data.dash && data.dash.video) || [];
  let list = videos.filter((v) => v.id === Number(qn));
  if (!list.length) list = videos;
  if (!list.length) return null;
  const rank = (codecid) => (codecid === 7 ? 0 : codecid === 12 ? 1 : codecid === 13 ? 2 : 3);
  list.sort((a, b) => rank(a.codecid) - rank(b.codecid) || (b.bandwidth || 0) - (a.bandwidth || 0));
  return list[0];
}

function audioUrlOf(audio) {
  return audio ? (audio.baseUrl || audio.base_url) : '';
}

function videoUrlOf(video) {
  return video ? (video.baseUrl || video.base_url) : '';
}

function streamUrl(data, qn) {
  if (data.durl && data.durl.length) {
    return { url: data.durl[0].url || data.durl[0].base_url, hasAudio: true };
  }
  const video = pickVideoStream(data, qn);
  if (!video) throw new Error('该视频没有可用的视频流');
  const audio = pickAudio(data.dash && data.dash.audio);
  return {
    url: videoUrlOf(video),
    audioUrl: audioUrlOf(audio),
    hasAudio: !!audio
  };
}

// ---------- 路由 ----------
app.use(express.json({ limit: '1mb' }));

app.get('/api/settings', async (req, res) => {
  let uname = '';
  if (sessdata) {
    try {
      const nav = await biliGet('https://api.bilibili.com/x/web-interface/nav', 8000);
      if (nav && nav.isLogin) uname = nav.uname || '';
    } catch {}
  }
  res.json({ loggedIn: !!sessdata, hasFFmpeg, uname });
});

app.post('/api/settings', async (req, res) => {
  const next = typeof req.body?.sessdata === 'string' ? req.body.sessdata.trim() : '';
  if (!next) {
    sessdata = '';
    return res.json({ ok: true, loggedIn: false });
  }
  const previous = sessdata;
  sessdata = next;
  try {
    await ensureCookies();
    const nav = await fetch('https://api.bilibili.com/x/web-interface/nav', {
      headers: biliHeaders(),
      signal: AbortSignal.timeout(12000)
    }).then((r) => r.json());
    if (nav?.data?.isLogin) {
      playurlCache.clear();
      return res.json({ ok: true, loggedIn: true, uname: nav.data.uname });
    }
    sessdata = previous;
    return res.status(400).json({ ok: false, message: 'SESSDATA 无效或已过期' });
  } catch {
    sessdata = previous;
    return res.status(500).json({ ok: false, message: '校验登录状态失败，请稍后再试' });
  }
});

// ---------- 扫码登录 ----------
let qrSession = { key: '', createdAt: 0 };

app.get('/api/qrcode', async (req, res) => {
  try {
    const r = await fetch('https://passport.bilibili.com/x/passport-login/web/qrcode/generate', {
      headers: { 'User-Agent': UA, Referer: BILI_REFERER },
      signal: AbortSignal.timeout(12000)
    }).then((x) => x.json());
    if (r.code !== 0 || !r.data?.qrcode_key) throw new Error(r.message || '生成失败');
    qrSession = { key: r.data.qrcode_key, createdAt: Date.now() };
    res.json({ ok: true, key: r.data.qrcode_key, url: r.data.url });
  } catch (err) {
    res.status(502).json({ ok: false, message: '获取二维码失败：' + (err.message || '网络错误') });
  }
});

app.get('/api/qrcode/poll', async (req, res) => {
  const key = String(req.query.key || '');
  if (!key || key !== qrSession.key || Date.now() - qrSession.createdAt > 180000) {
    return res.json({ ok: false, code: 86038, message: '二维码已失效，请刷新' });
  }
  const pollUrl =
    'https://passport.bilibili.com/x/passport-login/web/qrcode/poll?qrcode_key=' +
    encodeURIComponent(key);
  let r = null;
  let setCookies = [];
  for (let i = 0; i < 2 && !r; i++) {
    try {
      const resp = await fetch(pollUrl, {
        headers: { 'User-Agent': UA, Referer: BILI_REFERER },
        signal: AbortSignal.timeout(12000)
      });
      setCookies = typeof resp.headers.getSetCookie === 'function' ? resp.headers.getSetCookie() : [];
      r = await resp.json();
    } catch (err) {
      console.log('[qr] poll 请求失败:', err.message);
    }
  }
  if (!r) return res.status(502).json({ ok: false, message: '轮询失败，请稍后再试' });

  const d = r.data || {};
  console.log(
    '[qr] poll code:', r.code, 'data.code:', d.code,
    'url:', String(d.url || '').replace(/(SESSDATA=)[^&"]+/g, '$1***'),
    'set-cookie:', setCookies.length
  );
  // 86101=未扫码 86090=已扫未确认 86038=已失效 0=已确认
  if (d.code === 0) {
    // 凭证可能在 Set-Cookie 头里，也可能在 url 参数里，依次尝试
    let sess = '';
    const cm = /SESSDATA=([^;]+)/.exec(setCookies.join('; '));
    if (cm) sess = cm[1];
    if (!sess && d.url) {
      try {
        sess = new URL(d.url).searchParams.get('SESSDATA') || '';
      } catch {}
    }
    if (!sess && d.url) {
      const m = /SESSDATA=([^&]+)/.exec(d.url);
      if (m) sess = decodeURIComponent(m[1]);
    }
    if (!sess) return res.status(502).json({ ok: false, message: '未获取到登录凭证' });
    sessdata = sess;
    playurlCache.clear();
    qrSession.key = '';
    console.log('[qr] 扫码登录成功');
    return res.json({ ok: true, code: 0 });
  }
  res.json({ ok: true, code: d.code ?? -1, message: d.message || '' });
});

// ---------- 个人中心（需要登录） ----------
function requireLogin(res) {
  if (sessdata) return true;
  res.status(401).json({ ok: false, message: '未登录，请先扫码登录' });
  return false;
}

async function fetchLoginNav() {
  const data = await biliGet('https://api.bilibili.com/x/web-interface/nav');
  if (!data || !data.isLogin) throw new BiliError(-101);
  return data;
}

function sendMeError(res, err) {
  const unauth = err.code === -101 || err.code === -104;
  res.status(unauth ? 401 : 400).json({ ok: false, message: err.message || '获取失败' });
}

app.get('/api/me', async (req, res) => {
  if (!requireLogin(res)) return;
  try {
    const d = await fetchLoginNav();
    res.json({
      ok: true,
      profile: {
        mid: d.mid,
        uname: d.uname,
        face: coverProxyUrl(d.face),
        level: (d.level_info && d.level_info.current_level) || 0,
        money: d.money || 0,
        vip: d.vipStatus === 1 && d.vip_label && d.vip_label.text ? d.vip_label.text : ''
      }
    });
  } catch (err) {
    sendMeError(res, err);
  }
});

app.get('/api/me/favorites', async (req, res) => {
  if (!requireLogin(res)) return;
  try {
    const nav = await fetchLoginNav();
    const data = await biliGet(
      `https://api.bilibili.com/x/v3/fav/folder/created/list-all?up_mid=${nav.mid}&type=2`
    );
    const list = ((data && data.list) || []).map((f) => ({
      id: f.id,
      title: f.title,
      count: f.media_count || 0
    }));
    res.json({ ok: true, list });
  } catch (err) {
    sendMeError(res, err);
  }
});

app.get('/api/me/favorites/:id', async (req, res) => {
  if (!requireLogin(res)) return;
  const id = String(req.params.id || '');
  if (!/^\d+$/.test(id)) return res.status(400).json({ ok: false, message: '参数不合法' });
  const pn = Math.min(Math.max(Number(req.query.pn) || 1, 1), 50);
  try {
    const data = await biliGet(
      `https://api.bilibili.com/x/v3/fav/resource/list?media_id=${id}&ps=40&pn=${pn}&platform=web`
    );
    const list = ((data && data.medias) || [])
      .filter((m) => m.bvid && m.attr === 0)
      .map((m) => ({
        bvid: m.bvid,
        title: m.title,
        cover: coverProxyUrl(m.cover),
        duration: m.duration || 0,
        author: (m.upper && m.upper.name) || ''
      }));
    res.json({ ok: true, list, hasMore: !!(data && data.has_more) });
  } catch (err) {
    sendMeError(res, err);
  }
});

app.get('/api/me/watchlater', async (req, res) => {
  if (!requireLogin(res)) return;
  try {
    const data = await biliGet('https://api.bilibili.com/x/v2/history/toview');
    const list = ((data && data.list) || [])
      .filter((m) => m.bvid)
      .map((m) => ({
        bvid: m.bvid,
        title: m.title,
        cover: coverProxyUrl(m.pic),
        duration: m.duration || 0,
        author: (m.owner && m.owner.name) || ''
      }));
    res.json({ ok: true, list });
  } catch (err) {
    sendMeError(res, err);
  }
});

app.get('/api/me/history', async (req, res) => {
  if (!requireLogin(res)) return;
  try {
    const data = await biliGet(
      'https://api.bilibili.com/x/web-interface/history/cursor?ps=30&type=archive'
    );
    const list = ((data && data.list) || [])
      .filter((m) => m.history && m.history.bvid)
      .map((m) => ({
        bvid: m.history.bvid,
        title: m.title,
        cover: coverProxyUrl(m.cover || (Array.isArray(m.covers) ? m.covers[0] : '')),
        duration: m.duration || 0,
        author: m.author_name || ''
      }));
    res.json({ ok: true, list });
  } catch (err) {
    sendMeError(res, err);
  }
});

app.post('/api/parse', async (req, res) => {
  const tokens = normalizeInput(req.body?.input);
  if (!tokens.length) {
    return res.status(400).json({ ok: false, message: '请先粘贴 B 站视频链接或 BV 号' });
  }

  const limited = tokens.slice(0, MAX_BATCH);
  const normalized = await mapLimit(limited, 4, async (token) => {
    try {
      if (token.type === 'invalid') throw new Error('无法识别的链接');
      if (token.type === 'short') return await resolveShortLink(token.value);
      return token;
    } catch (err) {
      return { type: 'invalid', value: token.raw || token.value, error: err.message };
    }
  });

  const items = await mapLimit(normalized, 3, async (token) => {
    if (token.type === 'invalid') {
      return { ok: false, input: token.value, error: token.error || '无法识别的链接' };
    }
    try {
      const info = await fetchVideoInfo(token);
      return { ok: true, ...info };
    } catch (err) {
      return { ok: false, input: token.raw || token.value, error: err.message || '解析失败' };
    }
  });

  // 同一视频的不同写法（链接 / BV 号 / av 号）只保留一条
  const seenBv = new Set();
  const deduped = items.filter((item) => {
    if (!item.ok) return true;
    if (seenBv.has(item.bvid)) return false;
    seenBv.add(item.bvid);
    return true;
  });

  res.json({
    ok: true,
    items: deduped,
    truncated: Math.max(0, tokens.length - MAX_BATCH)
  });
});

app.get('/api/qualities', async (req, res) => {
  const bvid = String(req.query.bvid || '');
  const cid = String(req.query.cid || '');
  if (!/^BV[0-9A-Za-z]{10}$/.test(bvid) || !/^\d+$/.test(cid)) {
    return res.status(400).json({ ok: false, message: '参数不合法' });
  }
  try {
    const data = await getPlayurl(bvid, cid);
    res.json({ ok: true, ...normalizePlayurl(data), hasFFmpeg });
  } catch (err) {
    res.status(400).json({ ok: false, message: err.message || '获取画质失败' });
  }
});

app.get('/api/cover', async (req, res) => {
  const raw = String(req.query.url || '');
  let target;
  try {
    target = new URL(raw);
  } catch {
    return res.status(400).end();
  }
  const host = target.hostname;
  if (!/\.hdslb\.com$/.test(host) || target.protocol !== 'https:') {
    return res.status(400).end();
  }
  try {
    const upstream = await fetch(target.toString(), {
      headers: { 'User-Agent': UA, Referer: BILI_REFERER },
      signal: AbortSignal.timeout(12000)
    });
    if (!upstream.ok) return res.status(502).end();
    res.setHeader('Content-Type', upstream.headers.get('content-type') || 'image/jpeg');
    res.setHeader('Cache-Control', 'public, max-age=86400');
    const body = Buffer.from(await upstream.arrayBuffer());
    res.end(body);
  } catch {
    res.status(502).end();
  }
});

function contentDisposition(filename) {
  const safe = filename.replace(/[\\/:*?"<>|]+/g, '_').slice(0, 150);
  const ascii = safe.replace(/[^\x20-\x7e]/g, '_').replace(/"/g, '');
  return `attachment; filename="${ascii || 'video'}.mp4"; filename*=UTF-8''${encodeURIComponent(safe || 'video')}.mp4`;
}

const DOWNLOAD_DIR = path.join(os.tmpdir(), 'wubli-downloads');
const DOWNLOAD_TTL = 30 * 60 * 1000;
const downloadJobs = new Map();

async function ensureMp4(key, streams, ffHeaders) {
  if (downloadJobs.has(key)) return downloadJobs.get(key);
  const job = (async () => {
    await fsp.mkdir(DOWNLOAD_DIR, { recursive: true });
    const target = path.join(DOWNLOAD_DIR, `${key}.mp4`);
    try {
      const st = await fsp.stat(target);
      if (st.size > 0 && Date.now() - st.mtimeMs < DOWNLOAD_TTL) return target;
    } catch {}

    const part = `${target}.${process.pid}.part`;
    await new Promise((resolve, reject) => {
      const args = [
        '-hide_banner', '-loglevel', 'error', '-nostdin',
        '-headers', ffHeaders, '-i', streams.url,
        '-headers', ffHeaders, '-i', streams.audioUrl,
        '-map', '0:v:0', '-map', '1:a:0',
        '-c', 'copy',
        '-movflags', '+faststart',
        '-f', 'mp4', part
      ];
      const ff = spawn(ffmpegPath, args);
      ff.stderr.on('data', (buf) => {
        const text = String(buf).trim();
        if (text) console.warn('[ffmpeg]', text.slice(0, 300));
      });
      ff.on('error', reject);
      ff.on('close', (code) => {
        if (code === 0) resolve();
        else reject(new Error(`ffmpeg 退出码 ${code}`));
      });
    });
    await fsp.rename(part, target);
    return target;
  })().finally(() => downloadJobs.delete(key));
  downloadJobs.set(key, job);
  return job;
}

async function cleanDownloads() {
  try {
    const now = Date.now();
    const names = await fsp.readdir(DOWNLOAD_DIR);
    await Promise.all(names.map(async (entry) => {
      const file = path.join(DOWNLOAD_DIR, entry);
      try {
        const st = await fsp.stat(file);
        if (now - st.mtimeMs > DOWNLOAD_TTL) await fsp.unlink(file);
      } catch {}
    }));
  } catch {}
}
setInterval(cleanDownloads, 10 * 60 * 1000).unref();

function decodeDownloadName(raw, fallback) {
  if (typeof raw === 'string' && raw) {
    try {
      const b64 = raw.replace(/-/g, '+').replace(/_/g, '/');
      const text = Buffer.from(b64, 'base64').toString('utf8');
      if (text) return text;
    } catch {}
  }
  return String(fallback || 'video');
}

app.get('/api/download', async (req, res) => {
  const bvid = String(req.query.bvid || '');
  const cid = String(req.query.cid || '');
  const qn = Number(req.query.qn) || 0;
  const name = decodeDownloadName(req.query.fn, req.query.name);

  if (!/^BV[0-9A-Za-z]{10}$/.test(bvid) || !/^\d+$/.test(cid)) {
    return res.status(400).json({ ok: false, message: '参数不合法' });
  }

  let data;
  try {
    data = await getPlayurl(bvid, cid);
  } catch (err) {
    return res.status(400).json({ ok: false, message: err.message || '获取视频流失败' });
  }

  let streams;
  try {
    streams = streamUrl(data, qn);
  } catch (err) {
    return res.status(400).json({ ok: false, message: err.message || '获取视频流失败' });
  }

  const ffHeaders = `Referer: ${BILI_REFERER}\r\nUser-Agent: ${UA}\r\n`;

  // 无音轨或不支持合并时直接透传视频流（无法提供 Content-Length / Range）
  if (!streams.audioUrl || !hasFFmpeg) {
    res.setHeader('Content-Type', 'video/mp4');
    res.setHeader('Content-Disposition', contentDisposition(name));
    res.setHeader('Cache-Control', 'no-store');
    return proxyStream(streams.url, res);
  }

  // 先生成完整 MP4 并缓存，响应带 Content-Length 与 Range 支持，
  // 避免分块（chunked）响应在预览代理/隧道中被中断，同时支持前端多连接分片下载。
  const key = crypto
    .createHash('sha1')
    .update(`${bvid}:${cid}:${qn}:${streams.url}:${streams.audioUrl}`)
    .digest('hex')
    .slice(0, 16);

  let file;
  try {
    file = await ensureMp4(key, streams, ffHeaders);
  } catch (err) {
    console.warn('[download]', err.message);
    return res.status(502).json({ ok: false, message: '视频合并失败，请稍后重试' });
  }

  res.sendFile(file, {
    headers: {
      'Content-Type': 'video/mp4',
      'Content-Disposition': contentDisposition(name),
      'Cache-Control': 'no-store'
    }
  }, (err) => {
    if (!err) return;
    console.warn('[download] sendFile:', err.message);
    if (!res.headersSent) res.status(500).json({ ok: false, message: '读取文件失败' });
  });
});

async function proxyStream(url, res) {
  if (!url) return res.status(400).end();
  try {
    const upstream = await fetch(url, {
      headers: { 'User-Agent': UA, Referer: BILI_REFERER },
      signal: AbortSignal.timeout(30000)
    });
    if (!upstream.ok) return res.destroy();
    const { Readable } = require('node:stream');
    Readable.fromWeb(upstream.body).pipe(res);
    res.on('close', () => upstream.body?.cancel?.());
  } catch {
    res.destroy();
  }
}

app.use(express.static(path.join(__dirname, 'public'), { maxAge: 0 }));

app.use((err, req, res, next) => {
  if (res.headersSent) return res.destroy();
  res.status(500).json({ ok: false, message: err.message || '服务器异常' });
});

app.listen(PORT, () => {
  console.log(`wubli 已启动: http://localhost:${PORT}  (ffmpeg: ${hasFFmpeg ? '可用' : '不可用'})`);
});

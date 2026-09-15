// ============================================================
// app.js - UFO-TW Controller (Pure JS, zero dependencies)
// ============================================================

// ---------- BLE ----------
const UFO_SERVICE = '40ee0200-63ec-4b7f-8ce7-712efd55b90e';
const UFO_CHAR    = '40ee0202-63ec-4b7f-8ce7-712efd55b90e';

// ---------- State ----------
let bleChar = null;
let isFlipped = false;
let playlist = [];
let script = [];
let lastCmd = { left: 0, right: 0 };
let currentIdx = -1;
let syncTimer = null;
let waveObserver = null;

let pendingEntries = [];

const $ = id => document.getElementById(id);
const player = $('player');

// ==================== BLE ====================

async function ble_connect() {
  console.log('ble_connect() called');
  try {
    const dev = await navigator.bluetooth.requestDevice({
      filters: [{ name: 'UFO-TW' }],
      optionalServices: [UFO_SERVICE]
    });
    console.log('Device selected:', dev.name);
    const srv = await dev.gatt.connect();
    dev.addEventListener('gattserverdisconnected', () => {
      bleChar = null;
      $('bleLabel').textContent = '未连接';
      $('bleLabel').className = 'badge off';
      console.log('BLE disconnected');
    });
    const svc = await srv.getPrimaryService(UFO_SERVICE);
    bleChar = await svc.getCharacteristic(UFO_CHAR);
    $('bleLabel').textContent = '已连接';
    $('bleLabel').className = 'badge on';
    console.log('BLE ready');
  } catch (e) {
    console.log('BLE error:', e.message || e);
  }
}

function ble_send(l, r) {
  if (!bleChar) return;
  if (isFlipped) [l, r] = [r, l];
  const enc = v => v < 0 ? ((~v + 129) & 0xFF) : (v & 0xFF);
  try {
    bleChar.writeValueWithoutResponse(new Uint8Array([0x05, enc(l), enc(r)]));
    lastCmd.left = l;
    lastCmd.right = r;
  } catch (e) { console.log('BLE write err:', e); }
}

// ==================== FILE INPUT ENTRY ====================

const MEDIA_EXTS = new Set(['.mp4','.webm','.mkv','.mov','.avi','.mp3','.wav','.ogg','.flac','.m4a']);

const MIME_MAP = {
  '.mp4': 'video/mp4', '.webm': 'video/webm', '.mkv': 'video/x-matroska',
  '.mov': 'video/quicktime', '.avi': 'video/x-msvideo',
  '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.ogg': 'audio/ogg',
  '.flac': 'audio/flac', '.m4a': 'audio/mp4',
  '.csv': 'text/csv', '.vtt': 'text/vtt',
};
const mime_for = ext => MIME_MAP[ext] || 'application/octet-stream';

async function folder_open() {
  console.log('folder_open() called');
  if (typeof window.showDirectoryPicker === 'function') {
    try {
      const dir = await window.showDirectoryPicker({ mode: 'read' });
      console.log('Folder selected:', dir.name);
      const entries = [];
      for await (const [name, h] of dir.entries()) {
        if (h.kind === 'file') entries.push({ name, getFile: () => h.getFile() });
      }
      pendingEntries = [];
      build_playlist(entries);
      return;
    } catch (e) {
      if (e.name === 'AbortError') return;
      console.log('Folder err:', e);
    }
  }
  $('fileInput').click();
}

function add_single_file() {
  $('singleFileInput').click();
}

$('fileInput').addEventListener('change', async (e) => {
  const files = Array.from(e.target.files || []);
  e.target.value = '';
  if (!files.length) return;
  pendingEntries = [];
  await handle_selected_files(files);
});

$('singleFileInput').addEventListener('change', async (e) => {
  const f = e.target.files && e.target.files[0];
  e.target.value = '';
  if (!f) return;

  $('folderLabel').textContent = '处理中…';

  if (f.name.toLowerCase().endsWith('.zip')) {
    try {
      const zipEntries = await read_zip(f);
      pendingEntries.push(...zipEntries);
    } catch (err) {
      console.log('ZIP err:', err);
      $('folderLabel').textContent = 'ZIP 解压失败';
      return;
    }
  } else {
    pendingEntries.push({ name: f.name, getFile: async () => f });
  }

  $('folderLabel').textContent = `已选 ${pendingEntries.length} 个`;
  build_playlist(pendingEntries.slice());
});

async function handle_selected_files(files) {
  $('folderLabel').textContent = '处理中…';
  const entries = [];

  for (const f of files) {
    if (f.name.toLowerCase().endsWith('.zip')) {
      try {
        const zipEntries = await read_zip(f);
        entries.push(...zipEntries);
        console.log('ZIP extracted:', f.name, '->', zipEntries.length, 'files');
      } catch (err) {
        console.log('ZIP err:', err);
        $('folderLabel').textContent = 'ZIP 解压失败';
        return;
      }
    } else {
      entries.push({ name: f.name, getFile: async () => f });
    }
  }

  build_playlist(entries);
}

function read_zip(file) {
  return new Promise(async (resolve, reject) => {
    if (typeof fflate === 'undefined') {
      reject(new Error('fflate not loaded'));
      return;
    }
    try {
      const buf = new Uint8Array(await file.arrayBuffer());
      fflate.unzip(buf, (err, files) => {
        if (err) { reject(err); return; }
        const entries = [];
        for (const [path, data] of Object.entries(files)) {
          if (!data || data.length === 0) continue;
          if (path.includes('__MACOSX')) continue;
          const name = path.split('/').pop();
          if (!name || name.startsWith('._') || name.startsWith('.')) continue;
          const dot = name.lastIndexOf('.');
          const ext = dot >= 0 ? name.substring(dot).toLowerCase() : '';
          const blob = new Blob([data], { type: mime_for(ext) });
          entries.push({ name, getFile: async () => blob });
        }
        resolve(entries);
      });
    } catch (e) {
      reject(e);
    }
  });
}

// ==================== PLAYLIST ====================

function build_playlist(entries) {
  console.log('build_playlist:', entries.length, 'entries');
  if (!entries.length) {
    $('folderLabel').textContent = '空';
    return;
  }

  const groups = new Map();
  for (const entry of entries) {
    const name = entry.name;
    const dot = name.lastIndexOf('.');
    const base = dot > 0 ? name.substring(0, dot) : name;
    const ext  = dot > 0 ? name.substring(dot).toLowerCase() : '';
    if (!groups.has(base)) groups.set(base, {});
    const g = groups.get(base);
    if (MEDIA_EXTS.has(ext)) g.media = entry;
    else if (ext === '.csv') g.csv = entry;
    else if (ext === '.vtt') g.vtt = entry;
  }

  playlist = [];
  for (const [base, g] of groups) {
    if (g.media) playlist.push({ base, mh: g.media, ch: g.csv || null, vh: g.vtt || null });
  }
  playlist.sort((a, b) => a.base.localeCompare(b.base));
  render_playlist();
  $('folderLabel').textContent = `(${playlist.length})`;
  console.log('Playlist built:', playlist.length, 'items');
  if (playlist.length > 0) pl_select(0);
}

function render_playlist() {
  const el = $('playlist');
  if (!playlist.length) {
    el.innerHTML = '<div style="padding:20px;color:#666;">未找到媒体文件</div>';
    return;
  }
  el.innerHTML = playlist.map((p, i) =>
    `<div class="pl-item" data-idx="${i}" onclick="pl_select(${i})">${p.base}</div>`
  ).join('');
}

// ==================== 字幕加载（关键改动） ====================

// 将 track 元素挂载到 video 并"默认开启"字幕
function attach_subtitle_track(trackEl) {
  // 1) 关键：先追加到 video，浏览器才会创建 TextTrack 对象
  player.appendChild(trackEl);

  const display = $('subDisplay');

  const updateSubs = () => {
    const t = trackEl.track;
    if (!t) return;
    const cues = t.activeCues;
    if (cues && cues.length > 0) {
      // 支持同一时刻多条 cue 叠加
      display.textContent = Array.from(cues).map(c => c.text).join('\n');
      display.style.display = 'block';
    } else {
      display.style.display = 'none';
    }
  };

  const enable = () => {
    if (!trackEl.track) return;
    // 'hidden' = 让 cue 保持活跃（cuechange 持续触发），但不渲染浏览器原生字幕
    // 我们自己用 #subDisplay 渲染，位置可控
    trackEl.track.mode = 'hidden';
    updateSubs();
  };

  if (trackEl.track) {
    // 部分浏览器创建元素时 TextTrack 就已存在
    enable();
    trackEl.track.addEventListener('cuechange', updateSubs);
  } else {
    // 常规路径：等 track 加载完成
    trackEl.addEventListener('load', () => {
      enable();
      if (trackEl.track) {
        trackEl.track.addEventListener('cuechange', updateSubs);
      }
    });
  }

  // 兜底：某些浏览器 load 事件不一定触发，延迟再尝试一次
  setTimeout(() => {
    if (trackEl.track && trackEl.track.mode === 'disabled') {
      trackEl.track.mode = 'hidden';
      trackEl.track.addEventListener('cuechange', updateSubs);
      updateSubs();
    }
  }, 300);

  // 视频开始播放 / seek 后立即刷新一次字幕
  player.addEventListener('seeked', updateSubs);
  player.addEventListener('playing', updateSubs);
}

async function pl_select(idx) {
  const p = playlist[idx];
  if (!p) return;
  console.log('pl_select:', idx, p.base);

  currentIdx = idx;
  document.querySelectorAll('.pl-item').forEach(el => el.classList.remove('active'));
  document.querySelector(`.pl-item[data-idx="${idx}"]`)?.classList.add('active');

  const file = await p.mh.getFile();
  const url = URL.createObjectURL(file);
  player.src = url;
  player.removeAttribute('hidden');
  player.style.display = 'block';
  $('placeholder').style.display = 'none';
  $('subDisplay').style.display = 'none';   // 切集时先隐藏旧字幕

  player.onerror = () => {
    console.log('Media load error');
    $('actionText').textContent = '加载媒体失败';
    $('placeholder').style.display = '';
    player.style.display = 'none';
  };
  player.onloadedmetadata = () => {
    console.log('Media metadata loaded, duration:', player.duration);
    schedule_draw();
  };

  // 清掉旧 track
  player.querySelectorAll('track').forEach(t => t.remove());

  if (p.vh) {
    const vf = await p.vh.getFile();
    const trk = document.createElement('track');
    trk.kind = 'subtitles';
    trk.label = '字幕';
    trk.default = true;           // 告诉浏览器这是默认字幕
    trk.src = URL.createObjectURL(vf);
    // 关键：不用等事件，直接挂上去；内部函数会处理启用
    attach_subtitle_track(trk);
  }

  if (p.ch) await load_csv(p.ch);
  else { script = []; $('actionText').textContent = '无脚本'; }

  if (window.innerWidth <= 700) close_sidebar();
}

async function load_csv(h) {
  const file = await h.getFile();
  const text = await file.text();
  const lines = text.split(/\r?\n/).filter(l => l.trim());
  script = [];
  for (const line of lines) {
    const cols = line.split(',').map(v => v.trim());
    if (cols.length < 3) continue;
    const ts = parseInt(cols[0]) * 100;
    if (cols.length >= 5) {
      let l = parseInt(cols[2]); if (cols[1] === '1') l = -l;
      let r = parseInt(cols[4]); if (cols[3] === '1') r = -r;
      script.push({ ts, left: l, right: r });
    } else {
      let p = parseInt(cols[2]); if (cols[1] === '1') p = -p;
      script.push({ ts, left: p, right: p });
    }
  }
  script.sort((a, b) => a.ts - b.ts);
  $('actionText').textContent = `脚本: ${script.length} 条`;
  console.log('CSV loaded:', script.length, 'actions');
  [0, 50, 150, 400, 1000, 2500].forEach(d => setTimeout(schedule_draw, d));
}

// ---------- Waveform Canvas ----------
let waveRetry = 0;
let drawScheduled = false;

function schedule_draw() {
  if (drawScheduled) return;
  drawScheduled = true;
  requestAnimationFrame(() => {
    drawScheduled = false;
    draw_waveform();
  });
}

function draw_waveform() {
  const canvas = $('waveCanvas');
  const wrap = $('waveWrap');
  if (!canvas || !wrap) return;

  const W = wrap.clientWidth;
  const H = wrap.clientHeight;

  if (W < 2 || H < 2) {
    if (waveRetry++ < 240) requestAnimationFrame(draw_waveform);
    return;
  }
  waveRetry = 0;

  const dpr = window.devicePixelRatio || 1;
  const pw = Math.floor(W * dpr);
  const ph = Math.floor(H * dpr);

  if (canvas.width !== pw)  canvas.width  = pw;
  if (canvas.height !== ph) canvas.height = ph;
  canvas.style.width  = W + 'px';
  canvas.style.height = H + 'px';

  const ctx = canvas.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, W, H);

  if (!script.length) return;

  const totalMs = script[script.length - 1].ts;
  if (totalMs <= 0) return;

  const barW = Math.max(1, Math.round(W / 800));
  const bars = Math.max(1, Math.floor(W / barW));
  const binMs = totalMs / bars;

  const peaks = new Array(bars).fill(0);
  let si = 0;
  for (let b = 0; b < bars; b++) {
    const tEnd = (b + 1) * binMs;
    while (si < script.length && script[si].ts < tEnd) {
      const v = Math.max(Math.abs(script[si].left), Math.abs(script[si].right)) / 127;
      if (v > peaks[b]) peaks[b] = v;
      si++;
    }
  }

  for (let b = 0; b < bars; b++) {
    const p = peaks[b];
    if (p === 0) continue;
    const barH = Math.max(1, Math.floor(p * H));
    const y = H - barH;
    const alpha = 0.4 + p * 0.6;
    ctx.fillStyle = p > 0.7 ? `rgba(255,80,80,${alpha})` : `rgba(83,52,131,${alpha})`;
    ctx.fillRect(b * barW, y, Math.max(1, barW - 1), barH);
  }

  $('wavePos').style.left = '0px';
}

function update_wave_pos() {
  if (!player.duration || !script.length) return;
  const totalMs = script[script.length - 1].ts;
  const ratio = player.currentTime * 1000 / totalMs;
  $('wavePos').style.left = (Math.min(1, ratio) * $('waveWrap').clientWidth) + 'px';
}

function setup_observers() {
  if (typeof ResizeObserver === 'undefined') return;
  const wrap = $('waveWrap');
  if (!wrap) return;
  waveObserver = new ResizeObserver(() => { if (script.length) schedule_draw(); });
  waveObserver.observe(wrap);
  try { waveObserver.observe(document.body); } catch (e) {}
}

window.addEventListener('resize', () => { if (script.length) schedule_draw(); });
window.addEventListener('orientationchange', () => { if (script.length) schedule_draw(); });
document.addEventListener('visibilitychange', () => { if (script.length) schedule_draw(); });
if (window.visualViewport) {
  window.visualViewport.addEventListener('resize', () => { if (script.length) schedule_draw(); });
}

// ==================== SYNC ====================

function get_cmd(ms) {
  if (!script.length) return { left: 0, right: 0 };
  if (ms < script[0].ts) return { left: 0, right: 0 };
  let lo = 0, hi = script.length - 1, idx = 0;
  while (lo <= hi) {
    const m = (lo + hi) >> 1;
    if (ms >= script[m].ts) { idx = m; lo = m + 1; }
    else hi = m - 1;
  }
  return { left: script[idx].left, right: script[idx].right };
}

player.addEventListener('play', () => {
  if (syncTimer) clearInterval(syncTimer);
  syncTimer = setInterval(() => {
    if (!player.currentTime || !script.length) return;
    const cmd = get_cmd(player.currentTime * 1000);
    if (cmd.left !== lastCmd.left || cmd.right !== lastCmd.right) {
      ble_send(cmd.left, cmd.right);
      $('actionText').textContent =
        `左:${cmd.left<0?'反':'正'}${Math.abs(cmd.left)} 右:${cmd.right<0?'反':'正'}${Math.abs(cmd.right)}`;
    }
  }, 50);
});

player.addEventListener('pause', () => {
  if (syncTimer) { clearInterval(syncTimer); syncTimer = null; }
  ble_send(0, 0);
});

player.addEventListener('ended', () => {
  if (syncTimer) { clearInterval(syncTimer); syncTimer = null; }
  ble_send(0, 0);
  const next = currentIdx + 1;
  if (next < playlist.length) {
    pl_select(next).then(() => { player.play().catch(() => {}); });
  }
});

player.addEventListener('timeupdate', () => {
  if (!player.duration) return;
  $('timeText').textContent =
    fmt_time(player.currentTime) + ' / ' + fmt_time(player.duration);
  update_wave_pos();
});

// ==================== UTIL ====================

function fmt_time(s) {
  const m = Math.floor(s / 60), sec = Math.floor(s % 60);
  return String(m).padStart(2, '0') + ':' + String(sec).padStart(2, '0');
}

function flip_toggle() {
  isFlipped = !isFlipped;
  const btn = $('btnFlip');
  btn.classList.toggle('flip-on', isFlipped);
  btn.textContent = isFlipped ? '🔀 已交换左右电机' : '🔀 交换左右电机';
}

function toggle_sidebar() {
  const sb = $('sidebar');
  const bd = $('sidebarBackdrop');
  if (!sb) return;
  sb.classList.toggle('open');
  if (bd) bd.classList.toggle('open', sb.classList.contains('open'));
}
function close_sidebar() {
  const sb = $('sidebar');
  const bd = $('sidebarBackdrop');
  if (sb) sb.classList.remove('open');
  if (bd) bd.classList.remove('open');
}

setup_observers();
window.addEventListener('load', () => { setTimeout(schedule_draw, 100); });
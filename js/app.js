// app.js — UI wiring: inputs, track list, preview, export

import { AudioEngine } from './audio-engine.js';
import { exportBuffer, triggerDownload } from './exporter.js';

const engine = new AudioEngine();
const AudioCtx = window.AudioContext || window.webkitAudioContext;

const $ = (id) => document.getElementById(id);
const fileInput = $('fileInput');
const urlInput = $('urlInput');
const loadUrlBtn = $('loadUrlBtn');
const urlStatus = $('urlStatus');
const trackList = $('trackList');
const trackCount = $('trackCount');
const emptyState = $('emptyState');
const previewBtn = $('previewBtn');
const exportBtn = $('exportBtn');
const formatSelect = $('formatSelect');
const exportStatus = $('exportStatus');
const progressBar = $('progressBar');
const progressLabel = $('progressLabel');
const timeLabel = $('timeLabel');
const visualizer = $('visualizer');
const toast = $('toast');

const fmtTime = (s) => {
  if (!isFinite(s)) return '0:00';
  const m = Math.floor(s / 60), sec = Math.floor(s % 60);
  return `${m}:${String(sec).padStart(2, '0')}`;
};

let toastTimer;
function showToast(msg, type = 'info') {
  toast.textContent = msg;
  toast.className = `fixed bottom-6 left-1/2 -translate-x-1/2 px-4 py-2 rounded-lg text-sm font-medium shadow-lg show ${type}`;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toast.classList.remove('show'), 3500);
}

// ---------- Decoding ----------

async function decodeFile(file) {
  engine.ensureContext();
  const ab = await file.arrayBuffer();
  const buffer = await engine.ctx.decodeAudioData(ab);
  return { buffer, name: file.name };
}

async function decodeUrl(url) {
  engine.ensureContext();
  const res = await fetch(url, { mode: 'cors' });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const ab = await res.arrayBuffer();
  const buffer = await engine.ctx.decodeAudioData(ab);
  const name = decodeURIComponent(url.split('/').pop().split('?')[0]) || 'remote-audio';
  return { buffer, name };
}

// ---------- Track list UI ----------

function renderTracks() {
  const tracks = engine.tracksList;
  trackCount.textContent = `(${tracks.length})`;
  emptyState.style.display = tracks.length ? 'none' : '';

  trackList.querySelectorAll('.track-row').forEach((el) => el.remove());

  for (const t of tracks) {
    const li = document.createElement('li');
    li.className = 'track-row flex flex-wrap items-center gap-3 bg-slate-800/50 border border-slate-800 rounded-xl px-4 py-3';
    li.innerHTML = `
      <div class="min-w-0 flex-1">
        <div class="text-sm font-medium truncate">${escapeHtml(t.name)}</div>
        <div class="text-xs text-slate-400">${fmtTime(t.buffer.duration)} · ${t.buffer.numberOfChannels}ch · ${(t.buffer.sampleRate / 1000).toFixed(1)}kHz</div>
      </div>
      <span class="text-xs px-2 py-0.5 rounded-full ${t.playing ? 'bg-emerald-500/20 text-emerald-300' : 'bg-slate-700 text-slate-400'}">
        ${t.playing ? 'Playing' : 'Idle'}
      </span>
      <input type="range" min="0" max="1" step="0.01" value="${t.volume}"
        class="volume w-24" title="Volume" />
      <button class="discard text-xs font-semibold text-rose-400 hover:text-rose-300 border border-rose-500/40 hover:border-rose-400 rounded-lg px-3 py-1.5 transition-colors">
        Discard
      </button>`;

    const vol = li.querySelector('.volume');
    vol.addEventListener('input', () => {
      engine.setVolume(t.id, parseFloat(vol.value));
    });

    li.querySelector('.discard').addEventListener('click', () => {
      engine.removeTrack(t.id);
      renderTracks();
      showToast(`Removed "${t.name}"`, 'info');
    });

    trackList.appendChild(li);
  }
}

function escapeHtml(s) {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

async function addToEngine({ buffer, name }) {
  engine.addTrack(buffer, name);
  renderTracks();
  showToast(`Added "${name}" (${fmtTime(buffer.duration)})`, 'success');
}

// ---------- Inputs ----------

fileInput.addEventListener('change', async () => {
  const files = [...fileInput.files];
  fileInput.value = '';
  for (const f of files) {
    try {
      const { buffer, name } = await decodeFile(f);
      await addToEngine({ buffer, name });
    } catch (err) {
      showToast(`Failed to decode "${f.name}": ${err.message}`, 'error');
    }
  }
});

loadUrlBtn.addEventListener('click', async () => {
  const url = urlInput.value.trim();
  if (!url) return;
  loadUrlBtn.disabled = true;
  urlStatus.textContent = 'Fetching…';
  try {
    const { buffer, name } = await decodeUrl(url);
    await addToEngine({ buffer, name });
    urlStatus.textContent = '';
    urlInput.value = '';
  } catch (err) {
    urlStatus.textContent = `Error: ${err.message}`;
    showToast(`URL load failed: ${err.message}`, 'error');
  } finally {
    loadUrlBtn.disabled = false;
  }
});

// ---------- Preview ----------

let previewing = false;
previewBtn.addEventListener('click', async () => {
  if (previewing) {
    engine.stopPreview(); // onEnded-ish cleanup happens below via promise resolution
    return;
  }
  if (!engine.tracksList.length) {
    showToast('Add at least one track first', 'error');
    return;
  }
  engine.ensureContext();
  previewing = true;
  previewBtn.disabled = true;
  previewBtn.textContent = '⏹ Stop Preview';
  progressLabel.textContent = 'Playing…';

  // visualizer loop
  const canvasCtx = visualizer.getContext('2d');
  let rafId;
  const draw = () => {
    const data = engine.getAnalyserData();
    const w = visualizer.width = visualizer.clientWidth * devicePixelRatio;
    const h = visualizer.height = visualizer.clientHeight * devicePixelRatio;
    canvasCtx.clearRect(0, 0, w, h);
    if (data) {
      const bars = 64;
      const bw = w / bars;
      for (let i = 0; i < bars; i++) {
        const v = data[Math.floor((i / bars) * data.length)] / 255;
        const bh = Math.max(2, v * h);
        canvasCtx.fillStyle = `hsl(${190 + i * 1.2}, 80%, ${45 + v * 20}%)`;
        canvasCtx.fillRect(i * bw + 1, h - bh, bw - 2, bh);
      }
    }
    rafId = requestAnimationFrame(draw);
  };
  draw();

  await engine.startPreview((frac, elapsed, dur) => {
    progressBar.style.width = `${frac * 100}%`;
    timeLabel.textContent = `${fmtTime(elapsed)} / ${fmtTime(dur)}`;
  });

  cancelAnimationFrame(rafId);
  progressBar.style.width = '0%';
  timeLabel.textContent = `0:00 / ${fmtTime(engine.totalDuration())}`;
  progressLabel.textContent = 'Ready';
  previewBtn.textContent = '▶ Test / Preview Combined Sound';
  previewBtn.disabled = false;
  previewing = false;
  renderTracks();
});

// ---------- Export ----------

exportBtn.addEventListener('click', async () => {
  if (!engine.tracksList.length) {
    showToast('Nothing to export — add tracks first', 'error');
    return;
  }
  const format = formatSelect.value;
  exportBtn.disabled = true;
  exportStatus.textContent = `Rendering ${format.toUpperCase()}…`;
  try {
    const buffer = await engine.renderOffline();
    const { blob, ext } = await exportBuffer(buffer, format);
    const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    triggerDownload(blob, `combined-sound-${stamp}.${ext}`);
    exportStatus.textContent = `Done — downloaded .${ext} (${(blob.size / 1024 / 1024).toFixed(2)} MB)`;
    showToast('Export complete', 'success');
  } catch (err) {
    exportStatus.textContent = `Export failed: ${err.message}`;
    showToast(`Export failed: ${err.message}`, 'error');
  } finally {
    exportBtn.disabled = false;
  }
});

// ---------- Init ----------

renderTracks();

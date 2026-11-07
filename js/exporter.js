// exporter.js — encode AudioBuffer to WAV / MP3 / OGG and trigger download

export function encodeWAV(buffer) {
  const numCh = Math.min(2, buffer.numberOfChannels);
  const sr = buffer.sampleRate;
  const len = buffer.length;
  const bytesPerSample = 2;
  const blockAlign = numCh * bytesPerSample;
  const dataSize = len * blockAlign;
  const ab = new ArrayBuffer(44 + dataSize);
  const v = new DataView(ab);

  const ws = (o, s) => { for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i)); };
  ws(0, 'RIFF'); v.setUint32(4, 36 + dataSize, true); ws(8, 'WAVE');
  ws(12, 'fmt '); v.setUint32(16, 16, true); v.setUint16(20, 1, true);
  v.setUint16(22, numCh, true); v.setUint32(24, sr, true);
  v.setUint32(28, sr * blockAlign, true); v.setUint16(32, blockAlign, true);
  v.setUint16(34, 16, true); ws(36, 'data'); v.setUint32(40, dataSize, true);

  const chans = [];
  for (let c = 0; c < numCh; c++) chans.push(buffer.getChannelData(c));

  let off = 44;
  for (let i = 0; i < len; i++) {
    for (let c = 0; c < numCh; c++) {
      let s = Math.max(-1, Math.min(1, chans[c][i]));
      v.setInt16(off, s < 0 ? s * 0x8000 : s * 0x7fff, true);
      off += 2;
    }
  }
  return new Blob([ab], { type: 'audio/wav' });
}

function floatTo16BitPCM(float32) {
  const out = new Int16Array(float32.length);
  for (let i = 0; i < float32.length; i++) {
    const s = Math.max(-1, Math.min(1, float32[i]));
    out[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
  }
  return out;
}

function downsampleToMono(buffer, targetRate) {
  const src = buffer.getChannelData(0);
  const ratio = buffer.sampleRate / targetRate;
  const outLen = Math.floor(src.length / ratio);
  const out = new Float32Array(outLen);
  for (let i = 0; i < outLen; i++) {
    const pos = i * ratio;
    const i0 = Math.floor(pos), i1 = Math.min(i0 + 1, src.length - 1);
    const frac = pos - i0;
    out[i] = src[i0] * (1 - frac) + src[i1] * frac;
  }
  return out;
}

async function ensureLamejs() {
  if (window.lamejs) return window.lamejs;
  await new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = 'https://cdn.jsdelivr.net/npm/lamejs@1.2.1/lame.min.js';
    s.onload = resolve;
    s.onerror = () => reject(new Error('Failed to load lamejs for MP3 encoding'));
    document.head.appendChild(s);
  });
  return window.lamejs;
}

export async function encodeMP3(buffer, kbps = 192) {
  const lame = await ensureLamejs();
  const rate = 44100;
  const mono = downsampleToMono(buffer, rate);
  const pcm = floatTo16BitPCM(mono);
  const enc = new lame.Mp3Encoder(1, rate, kbps);
  const chunks = [];
  const block = 1152;
  for (let i = 0; i < pcm.length; i += block) {
    const buf = pcm.subarray(i, Math.min(i + block, pcm.length));
    const data = enc.encodeBuffer(buf);
    if (data.length) chunks.push(new Int8Array(data));
  }
  const tail = enc.flush();
  if (tail.length) chunks.push(new Int8Array(tail));
  return new Blob(chunks, { type: 'audio/mpeg' });
}

export async function encodeOGG(buffer) {
  // Browsers can't encode OGG natively; capture via MediaRecorder as webm/opus.
  const mime = MediaRecorder.isTypeSupported('audio/webm;codecs=opus')
    ? 'audio/webm;codecs=opus'
    : MediaRecorder.isTypeSupported('audio/mp4') ? 'audio/mp4' : '';
  if (!mime) throw new Error('OGG export is not supported by this browser. Try WAV or MP3.');

  // MediaRecorder can't take an AudioBuffer directly — play it through a live
  // context into a MediaStreamDestination and capture the stream.
  const liveCtx = new AudioContext();
  const dest = liveCtx.createMediaStreamDestination();
  const liveSrc = liveCtx.createBufferSource();
  liveSrc.buffer = buffer;
  liveSrc.connect(dest);

  const rec = new MediaRecorder(dest.stream, { mimeType: mime });
  const chunks = [];
  rec.ondataavailable = (e) => e.data.size && chunks.push(e.data);
  const done = new Promise((res) => { rec.onstop = res; });
  rec.start();
  liveSrc.start();
  await new Promise((res) => setTimeout(res, buffer.duration * 1000 + 200));
  rec.stop();
  await done;
  liveCtx.close();
  const ext = mime.includes('mp4') ? 'm4a' : 'webm';
  const blob = new Blob(chunks, { type: mime });
  return { blob, ext };
}

export async function exportBuffer(buffer, format) {
  switch (format) {
    case 'wav':
      return { blob: encodeWAV(buffer), ext: 'wav' };
    case 'mp3':
      return { blob: await encodeMP3(buffer), ext: 'mp3' };
       case 'ogg': {
      const { blob, ext } = await encodeOGG(buffer);
      return { blob, ext };
    }
    default:
      throw new Error(`Unknown format: ${format}`);
  }
}

export function triggerDownload(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

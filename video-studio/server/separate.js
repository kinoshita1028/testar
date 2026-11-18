// 声と BGM の分離（MDX-Net / UVR の公開モデルを ONNX Runtime でローカル実行）
import fs from 'node:fs';
import path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { DIRS } from './config.js';
import { runFfmpeg } from './ffmpeg.js';
import { newId } from './util.js';

/** 声を取り出すモデル（Ultimate Vocal Remover で公開されている MDX-Net の声用モデル） */
export const MODEL = {
  name: 'UVR-MDX-NET-Voc_FT',
  url: 'https://github.com/TRvlvr/model_repo/releases/download/all_public_uvr_models/UVR-MDX-NET-Voc_FT.onnx',
  size: 66762490,
  nFft: 7680,
  hop: 1024,
  dimF: 3072,
  dimT: 256,
  compensate: 1.021,
  sampleRate: 44100,
};

const MODEL_DIR = path.join(DIRS.data, 'models');
fs.mkdirSync(MODEL_DIR, { recursive: true });
const modelPath = () => path.join(MODEL_DIR, `${MODEL.name}.onnx`);

let ortModule = null;
async function loadOrt() {
  if (ortModule) return ortModule;
  try {
    ortModule = (await import('onnxruntime-node')).default ?? (await import('onnxruntime-node'));
    return ortModule;
  } catch {
    const err = new Error('声と BGM を分ける部品（onnxruntime-node）が入っていません。ツールのフォルダで npm install をもう一度実行してください。');
    err.friendly = true;
    throw err;
  }
}

export async function separationStatus() {
  let available = true;
  try {
    await loadOrt();
  } catch {
    available = false;
  }
  return { available, modelDownloaded: fs.existsSync(modelPath()) && fs.statSync(modelPath()).size === MODEL.size, modelSizeMB: Math.round(MODEL.size / 1e6) };
}

/** 初回だけモデルをダウンロード */
async function ensureModel(onProgress) {
  const file = modelPath();
  if (fs.existsSync(file) && fs.statSync(file).size === MODEL.size) return file;
  const tmp = `${file}.download`;
  const res = await fetch(MODEL.url, { redirect: 'follow' });
  if (!res.ok || !res.body) {
    const err = new Error(`分離 AI のデータをダウンロードできませんでした（${res.status}）。インターネット接続を確認してください。`);
    err.friendly = true;
    throw err;
  }
  const total = Number(res.headers.get('content-length')) || MODEL.size;
  let got = 0;
  const reader = Readable.fromWeb(res.body);
  reader.on('data', (c) => {
    got += c.length;
    onProgress?.(got / total);
  });
  await pipeline(reader, fs.createWriteStream(tmp));
  if (fs.statSync(tmp).size !== MODEL.size) {
    fs.rmSync(tmp, { force: true });
    throw new Error('分離 AI のデータのダウンロードが途中で切れました。もう一度試してください。');
  }
  fs.renameSync(tmp, file);
  return file;
}

let sessionPromise = null;
async function getSession(onProgress) {
  const ort = await loadOrt();
  const file = await ensureModel(onProgress);
  sessionPromise ||= ort.InferenceSession.create(file, { graphOptimizationLevel: 'all' });
  return { ort, session: await sessionPromise };
}

// ------------------------------------------------------------------ FFT（任意の長さ: Bluestein 法）
class Radix2 {
  constructor(n) {
    this.n = n;
    this.levels = Math.log2(n);
    this.cos = new Float64Array(n / 2);
    this.sin = new Float64Array(n / 2);
    for (let i = 0; i < n / 2; i++) {
      this.cos[i] = Math.cos((2 * Math.PI * i) / n);
      this.sin[i] = Math.sin((2 * Math.PI * i) / n);
    }
    this.rev = new Uint32Array(n);
    for (let i = 0; i < n; i++) {
      let r = 0;
      for (let b = 0, x = i; b < this.levels; b++, x >>= 1) r = (r << 1) | (x & 1);
      this.rev[i] = r;
    }
  }
  /** 順変換（e^{-i}）をその場で行う */
  forward(re, im) {
    const n = this.n;
    for (let i = 0; i < n; i++) {
      const j = this.rev[i];
      if (j > i) {
        let t = re[i]; re[i] = re[j]; re[j] = t;
        t = im[i]; im[i] = im[j]; im[j] = t;
      }
    }
    for (let size = 2; size <= n; size <<= 1) {
      const half = size >> 1;
      const step = n / size;
      for (let i = 0; i < n; i += size) {
        for (let j = i, k = 0; j < i + half; j++, k += step) {
          const l = j + half;
          const tr = re[l] * this.cos[k] + im[l] * this.sin[k];
          const ti = -re[l] * this.sin[k] + im[l] * this.cos[k];
          re[l] = re[j] - tr;
          im[l] = im[j] - ti;
          re[j] += tr;
          im[j] += ti;
        }
      }
    }
  }
}

class Bluestein {
  constructor(n) {
    this.n = n;
    let m = 1;
    while (m < 2 * n - 1) m <<= 1;
    this.m = m;
    this.fft = new Radix2(m);
    this.cr = new Float64Array(n);
    this.ci = new Float64Array(n);
    for (let k = 0; k < n; k++) {
      const a = (Math.PI * ((k * k) % (2 * n))) / n;
      this.cr[k] = Math.cos(a);
      this.ci[k] = -Math.sin(a); // c[k] = e^{-iπk²/N}
    }
    // b[m] = conj(c[m])（両方向に折り返し）の FFT
    this.br = new Float64Array(m);
    this.bi = new Float64Array(m);
    for (let k = 0; k < n; k++) {
      this.br[k] = this.cr[k];
      this.bi[k] = -this.ci[k];
      if (k > 0) {
        this.br[m - k] = this.cr[k];
        this.bi[m - k] = -this.ci[k];
      }
    }
    this.fft.forward(this.br, this.bi);
    this.ar = new Float64Array(m);
    this.ai = new Float64Array(m);
  }
  /** X = DFT(x)（e^{-2πink/N}）。入出力は長さ n の配列 */
  dft(xr, xi, outR, outI) {
    const { n, m, ar, ai, cr, ci, br, bi } = this;
    ar.fill(0);
    ai.fill(0);
    for (let k = 0; k < n; k++) {
      ar[k] = xr[k] * cr[k] - xi[k] * ci[k];
      ai[k] = xr[k] * ci[k] + xi[k] * cr[k];
    }
    this.fft.forward(ar, ai);
    for (let k = 0; k < m; k++) {
      const r = ar[k] * br[k] - ai[k] * bi[k];
      const i = ar[k] * bi[k] + ai[k] * br[k];
      ar[k] = r;
      ai[k] = -i; // 逆変換のため共役
    }
    this.fft.forward(ar, ai);
    for (let k = 0; k < n; k++) {
      const r = ar[k] / m;
      const i = -ai[k] / m;
      outR[k] = r * cr[k] - i * ci[k];
      outI[k] = r * ci[k] + i * cr[k];
    }
  }
  /** x = IDFT(X) */
  idft(xr, xi, outR, outI) {
    const n = this.n;
    const tr = this._tr || (this._tr = new Float64Array(n));
    const ti = this._ti || (this._ti = new Float64Array(n));
    for (let k = 0; k < n; k++) {
      tr[k] = xr[k];
      ti[k] = -xi[k];
    }
    this.dft(tr, ti, outR, outI);
    for (let k = 0; k < n; k++) {
      outR[k] /= n;
      outI[k] = -outI[k] / n;
    }
  }
}

// ------------------------------------------------------------------ STFT / iSTFT（torch.stft / istft と同じ定義）
class Spectral {
  constructor({ nFft, hop, dimF, dimT }) {
    Object.assign(this, { nFft, hop, dimF, dimT });
    this.bs = new Bluestein(nFft);
    this.win = new Float64Array(nFft);
    for (let i = 0; i < nFft; i++) this.win[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / nFft); // periodic Hann
    this.zr = new Float64Array(nFft);
    this.zi = new Float64Array(nFft);
    this.Zr = new Float64Array(nFft);
    this.Zi = new Float64Array(nFft);
  }

  /** ステレオの 1 チャンク → モデル入力 [4, dimF, dimT]（L実, L虚, R実, R虚） */
  stft(L, R, out) {
    const { nFft, hop, dimF, dimT, win, zr, zi, Zr, Zi } = this;
    const pad = nFft / 2;
    const len = L.length;
    const at = (x, i) => {
      // reflect パディング
      let j = i - pad;
      if (j < 0) j = -j;
      if (j >= len) j = 2 * (len - 1) - j;
      return x[j];
    };
    const plane = dimF * dimT;
    for (let t = 0; t < dimT; t++) {
      const s = t * hop;
      for (let n = 0; n < nFft; n++) {
        zr[n] = win[n] * at(L, s + n);
        zi[n] = win[n] * at(R, s + n);
      }
      this.bs.dft(zr, zi, Zr, Zi);
      for (let k = 0; k < dimF; k++) {
        const nk = k === 0 ? 0 : nFft - k;
        const ar = Zr[k], ai = Zi[k], br = Zr[nk], bi = Zi[nk];
        const idx = k * dimT + t;
        out[idx] = (ar + br) / 2; // L 実部
        out[plane + idx] = (ai - bi) / 2; // L 虚部
        out[2 * plane + idx] = (ai + bi) / 2; // R 実部
        out[3 * plane + idx] = (br - ar) / 2; // R 虚部
      }
    }
    // 低い 3 ビンは 0 にする（UVR と同じ前処理）
    for (let c = 0; c < 4; c++) for (let k = 0; k < 3; k++) for (let t = 0; t < dimT; t++) out[c * plane + k * dimT + t] = 0;
  }

  /** モデル出力 [4, dimF, dimT] → ステレオの波形（長さ hop*(dimT-1)） */
  istft(spec) {
    const { nFft, hop, dimF, dimT, win, Zr, Zi, zr, zi } = this;
    const plane = dimF * dimT;
    const half = nFft / 2;
    const total = nFft + hop * (dimT - 1);
    const outL = new Float64Array(total);
    const outR = new Float64Array(total);
    const env = new Float64Array(total);
    const g = (c, k, t) => (k < dimF ? spec[c * plane + k * dimT + t] : 0);
    for (let t = 0; t < dimT; t++) {
      for (let k = 0; k <= half; k++) {
        const Lr = g(0, k, t), Li = k === 0 || k === half ? 0 : g(1, k, t);
        const Rr = g(2, k, t), Ri = k === 0 || k === half ? 0 : g(3, k, t);
        // Z = L + iR（L, R はエルミート対称）
        Zr[k] = Lr - Ri;
        Zi[k] = Li + Rr;
        if (k > 0 && k < half) {
          Zr[nFft - k] = Lr + Ri;
          Zi[nFft - k] = -Li + Rr;
        }
      }
      this.bs.idft(Zr, Zi, zr, zi);
      const s = t * hop;
      for (let n = 0; n < nFft; n++) {
        outL[s + n] += win[n] * zr[n];
        outR[s + n] += win[n] * zi[n];
        env[s + n] += win[n] * win[n];
      }
    }
    const len = hop * (dimT - 1);
    const L = new Float32Array(len);
    const R = new Float32Array(len);
    for (let i = 0; i < len; i++) {
      const e = env[i + half];
      L[i] = e > 1e-11 ? outL[i + half] / e : 0;
      R[i] = e > 1e-11 ? outR[i + half] / e : 0;
    }
    return [L, R];
  }
}

// ------------------------------------------------------------------ 分離本体
async function readPcm(file) {
  const raw = path.join(DIRS.tmp, `${newId('sep_in_')}.f32`);
  await runFfmpeg(['-i', file, '-vn', '-ac', '2', '-ar', String(MODEL.sampleRate), '-f', 'f32le', raw]);
  const buf = fs.readFileSync(raw);
  fs.rm(raw, { force: true }, () => {});
  const all = new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4);
  const n = all.length / 2;
  const L = new Float32Array(n);
  const R = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    L[i] = all[2 * i];
    R[i] = all[2 * i + 1];
  }
  return [L, R];
}

async function writeWav(L, R, out) {
  const raw = path.join(DIRS.tmp, `${newId('sep_out_')}.f32`);
  const inter = new Float32Array(L.length * 2);
  for (let i = 0; i < L.length; i++) {
    inter[2 * i] = L[i];
    inter[2 * i + 1] = R[i];
  }
  fs.writeFileSync(raw, Buffer.from(inter.buffer));
  try {
    await runFfmpeg(['-f', 'f32le', '-ar', String(MODEL.sampleRate), '-ac', '2', '-i', raw, '-c:a', 'pcm_s16le', out]);
  } finally {
    fs.rm(raw, { force: true }, () => {});
  }
}

/**
 * 音声ファイル（動画でも可）を「声」と「声以外（BGM・効果音）」に分ける
 * @returns {Promise<{ voice: string, background: string, seconds: number }>} WAV ファイルのパス
 */
export async function separateFile(file, { onProgress, highQuality = false } = {}) {
  const report = (p, msg) => onProgress?.(Math.max(0, Math.min(1, p)), msg);
  const { ort, session } = await getSession((p) => report(p * 0.15, `分離 AI のデータをダウンロード中（初回のみ・約 ${Math.round(MODEL.size / 1e6)}MB）… ${Math.round(p * 100)}%`));
  report(0.15, '音声を読み込んでいます…');
  const [mixL, mixR] = await readPcm(file);
  const n = mixL.length;
  if (!n) throw new Error('音声が空です');

  const { nFft, hop, dimF, dimT, compensate } = MODEL;
  const sp = new Spectral(MODEL);
  const trim = nFft / 2;
  const chunk = hop * (dimT - 1);
  const gen = chunk - 2 * trim;
  const pad = gen + trim - (n % gen);
  const total = trim + n + pad;
  const mL = new Float32Array(total);
  const mR = new Float32Array(total);
  mL.set(mixL, trim);
  mR.set(mixR, trim);
  const resL = new Float64Array(total);
  const resR = new Float64Array(total);
  const div = new Float64Array(total);
  const step = chunk - nFft;
  const input = new Float32Array(4 * dimF * dimT);
  const partL = new Float32Array(chunk);
  const partR = new Float32Array(chunk);
  const chunks = Math.ceil(total / step);

  const run = async (sign) => {
    if (sign < 0) for (let i = 0; i < input.length; i++) input[i] = -input[i];
    const out = await session.run({ [session.inputNames[0]]: new ort.Tensor('float32', input, [1, 4, dimF, dimT]) });
    const data = out[session.outputNames[0]].data;
    if (sign < 0) {
      const neg = new Float32Array(data.length);
      for (let i = 0; i < data.length; i++) neg[i] = -data[i];
      for (let i = 0; i < input.length; i++) input[i] = -input[i];
      return neg;
    }
    return data;
  };

  let c = 0;
  for (let i = 0; i < total; i += step) {
    const start = i;
    const end = Math.min(i + chunk, total);
    const actual = end - start;
    partL.fill(0);
    partR.fill(0);
    partL.set(mL.subarray(start, end));
    partR.set(mR.subarray(start, end));
    sp.stft(partL, partR, input);
    let spec = await run(1);
    if (highQuality) {
      // 符号を反転した入力でも推論して平均（ノイズが減る・時間は 2 倍）
      const neg = await run(-1);
      const avg = new Float32Array(spec.length);
      for (let k = 0; k < spec.length; k++) avg[k] = (spec[k] + neg[k]) / 2;
      spec = avg;
    }
    const [tL, tR] = sp.istft(spec);
    for (let k = 0; k < actual; k++) {
      const w = actual > 1 ? 0.5 - 0.5 * Math.cos((2 * Math.PI * k) / (actual - 1)) : 1; // np.hanning
      resL[start + k] += tL[k] * w;
      resR[start + k] += tR[k] * w;
      div[start + k] += w;
    }
    c++;
    report(0.2 + 0.75 * (c / chunks), `声と BGM を分けています… ${Math.round((c / chunks) * 100)}%`);
    await new Promise((r) => setImmediate(r));
  }

  const vL = new Float32Array(n);
  const vR = new Float32Array(n);
  const bL = new Float32Array(n);
  const bR = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const d = div[i + trim] > 1e-8 ? div[i + trim] : 1;
    vL[i] = (resL[i + trim] / d) * compensate;
    vR[i] = (resR[i + trim] / d) * compensate;
    bL[i] = mixL[i] - vL[i];
    bR[i] = mixR[i] - vR[i];
  }
  report(0.96, 'ファイルに書き出しています…');
  const voice = path.join(DIRS.tmp, `${newId('voice_')}.wav`);
  const background = path.join(DIRS.tmp, `${newId('bgm_')}.wav`);
  await writeWav(vL, vR, voice);
  await writeWav(bL, bR, background);
  return { voice, background, seconds: n / MODEL.sampleRate };
}

// テスト用に内部の部品も公開
export const _internal = { Bluestein, Spectral };

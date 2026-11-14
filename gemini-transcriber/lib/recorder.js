// Microphone capture + energy-based voice activity detection.
// Emits one "segment" (a block) each time the speaker pauses.

export const TARGET_RATE = 16000;

const FRAME_MS = 30;
const ONSET_FRAMES = 3; // ~90ms of sound above the threshold starts a block
const PRE_ROLL_MS = 350; // audio kept from just before speech started
const KEEP_TAIL_MS = 200; // silence kept after the last word
const MIN_VOICED_MS = 200; // shorter bursts are treated as noise
const HARD_CUT_EXTRA_MS = 8000; // force a cut this long after maxSegmentSec
const LONG_SEGMENT_SILENCE_MS = 250; // after maxSegmentSec, cut at the next short pause

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

export class SpeechRecorder {
  constructor({ onSegment, onLevel, onEnded, silenceMs = 900, sensitivity = 60, maxSegmentSec = 20 } = {}) {
    this.onSegment = onSegment;
    this.onLevel = onLevel;
    this.onEnded = onEnded;
    this.opts = { silenceMs, sensitivity, maxSegmentSec };
    this.running = false;
  }

  updateOptions(patch) {
    Object.assign(this.opts, patch);
  }

  async start() {
    this.stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        channelCount: 1,
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
      },
    });

    try {
      try {
        this.ctx = new AudioContext({ sampleRate: TARGET_RATE });
      } catch {
        this.ctx = new AudioContext();
      }
      if (this.ctx.state === 'suspended') await this.ctx.resume();
      await this.ctx.audioWorklet.addModule(new URL('./audio-worklet.js', import.meta.url));

      this.rate = this.ctx.sampleRate;
      this.frameSize = Math.round((this.rate * FRAME_MS) / 1000);
      this.frameMs = (this.frameSize / this.rate) * 1000;

      this.source = this.ctx.createMediaStreamSource(this.stream);
      this.node = new AudioWorkletNode(this.ctx, 'pcm-capture', {
        numberOfInputs: 1,
        numberOfOutputs: 1,
        channelCount: 1,
        channelCountMode: 'explicit',
        processorOptions: { frameSize: this.frameSize },
      });
      // A muted path to the destination keeps the graph pulling audio.
      this.sink = this.ctx.createGain();
      this.sink.gain.value = 0;
      this.source.connect(this.node);
      this.node.connect(this.sink);
      this.sink.connect(this.ctx.destination);
      this.node.port.onmessage = (e) => this._onFrame(e.data);
    } catch (err) {
      this._teardown();
      throw err;
    }

    const track = this.stream.getAudioTracks()[0];
    if (track) {
      track.addEventListener('ended', () => {
        if (this.running) this.onEnded?.();
      });
    }

    this._resetVad();
    this.running = true;
  }

  async stop({ flush = true } = {}) {
    if (!this.running) return;
    if (flush && this.speaking && this.seg.length) this._endSegment(false);
    this.running = false;
    this._teardown();
  }

  _teardown() {
    try {
      if (this.node) this.node.port.onmessage = null;
      this.source?.disconnect();
      this.node?.disconnect();
      this.sink?.disconnect();
    } catch {
      /* already disconnected */
    }
    this.stream?.getTracks().forEach((t) => t.stop());
    if (this.ctx && this.ctx.state !== 'closed') this.ctx.close().catch(() => {});
    this.source = this.node = this.sink = this.ctx = this.stream = null;
  }

  _resetVad() {
    this.noise = null;
    this.calibFrames = 0;
    this.preRoll = [];
    this.preRollMax = Math.ceil(PRE_ROLL_MS / this.frameMs);
    this.speaking = false;
    this.onset = 0;
    this.seg = [];
    this.silenceRun = 0;
    this.voiced = 0;
    this.segStartedAt = 0;
  }

  // Higher sensitivity = lower threshold (picks up quieter voices, and more noise).
  _thresholds() {
    const s = clamp(Number(this.opts.sensitivity) || 0, 0, 100) / 100;
    const ratio = 4.5 - 2.7 * s; // 4.5x .. 1.8x above the noise floor
    const absMin = 10 ** ((-34 - 20 * s) / 20); // -34 dBFS .. -54 dBFS
    const start = Math.max((this.noise ?? absMin) * ratio, absMin);
    return { start, cont: start * 0.55 };
  }

  _onFrame(frame) {
    if (!this.running) return;

    let sum = 0;
    for (let i = 0; i < frame.length; i++) sum += frame[i] * frame[i];
    const rms = Math.sqrt(sum / frame.length);

    // Track the background-noise level only while nobody is speaking.
    if (!this.speaking) {
      if (this.noise == null) this.noise = Math.max(rms, 1e-5);
      const alpha = this.calibFrames < 15 ? 0.3 : rms < this.noise ? 0.08 : 0.01;
      this.noise = Math.max(1e-5, this.noise + (rms - this.noise) * alpha);
      this.calibFrames++;
    }

    const { start, cont } = this._thresholds();

    if (!this.speaking) {
      this.preRoll.push(frame);
      if (this.preRoll.length > this.preRollMax) this.preRoll.shift();
      this.onset = rms >= start ? this.onset + 1 : 0;
      if (this.onset >= ONSET_FRAMES) {
        this.speaking = true;
        this.seg = this.preRoll;
        this.preRoll = [];
        this.voiced = this.onset;
        this.silenceRun = 0;
        this.onset = 0;
        this.segStartedAt = Date.now() - this.seg.length * this.frameMs;
      }
    } else {
      this.seg.push(frame);
      if (rms >= cont) {
        this.silenceRun = 0;
        this.voiced++;
      } else {
        this.silenceRun++;
      }
      const segMs = this.seg.length * this.frameMs;
      const maxMs = (Number(this.opts.maxSegmentSec) || 20) * 1000;
      const silenceLimit = segMs >= maxMs
        ? Math.min(LONG_SEGMENT_SILENCE_MS, this.opts.silenceMs)
        : Number(this.opts.silenceMs) || 900;

      if (this.silenceRun * this.frameMs >= silenceLimit) this._endSegment(false);
      else if (segMs >= maxMs + HARD_CUT_EXTRA_MS) this._endSegment(true);
    }

    this.onLevel?.({
      rms,
      threshold: start,
      speaking: this.speaking,
      segmentMs: this.speaking ? this.seg.length * this.frameMs : 0,
    });
  }

  _endSegment(hardCut) {
    let frames = this.seg;
    if (!hardCut) {
      const keepTail = Math.ceil(KEEP_TAIL_MS / this.frameMs);
      const drop = Math.max(0, this.silenceRun - keepTail);
      if (drop > 0) frames = frames.slice(0, frames.length - drop);
    }
    const voicedMs = this.voiced * this.frameMs;
    const startedAt = this.segStartedAt;

    this.seg = [];
    this.voiced = 0;
    this.silenceRun = 0;
    if (hardCut) {
      this.segStartedAt = Date.now(); // still talking: next block starts right away
    } else {
      this.speaking = false;
      this.preRoll = [];
    }

    if (voicedMs < MIN_VOICED_MS || frames.length === 0) return;

    let samples = concatFrames(frames);
    if (this.rate !== TARGET_RATE) samples = resample(samples, this.rate, TARGET_RATE);
    normalizePeak(samples);

    this.onSegment?.({
      samples,
      sampleRate: TARGET_RATE,
      startedAt,
      durationMs: (samples.length / TARGET_RATE) * 1000,
    });
  }
}

function concatFrames(frames) {
  let total = 0;
  for (const f of frames) total += f.length;
  const out = new Float32Array(total);
  let offset = 0;
  for (const f of frames) {
    out.set(f, offset);
    offset += f.length;
  }
  return out;
}

function resample(input, from, to) {
  const ratio = from / to;
  const outLen = Math.max(1, Math.floor(input.length / ratio));
  const out = new Float32Array(outLen);
  if (ratio >= 1) {
    // Downsample with a box filter (average of the covered input samples).
    for (let i = 0; i < outLen; i++) {
      const s = Math.floor(i * ratio);
      const e = Math.min(input.length, Math.max(s + 1, Math.floor((i + 1) * ratio)));
      let sum = 0;
      for (let j = s; j < e; j++) sum += input[j];
      out[i] = sum / (e - s);
    }
  } else {
    for (let i = 0; i < outLen; i++) {
      const pos = i * ratio;
      const j = Math.floor(pos);
      const t = pos - j;
      out[i] = (input[j] ?? 0) * (1 - t) + (input[j + 1] ?? input[j] ?? 0) * t;
    }
  }
  return out;
}

// Quiet recordings are boosted (up to 6x) so the model hears them clearly.
function normalizePeak(samples) {
  let peak = 0;
  for (let i = 0; i < samples.length; i++) peak = Math.max(peak, Math.abs(samples[i]));
  if (peak <= 0 || peak >= 0.5) return;
  const gain = Math.min(0.8 / peak, 6);
  for (let i = 0; i < samples.length; i++) samples[i] *= gain;
}

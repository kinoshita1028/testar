// Real-time transcription over the Gemini Live API (WebSocket), designed for
// gemini-3.5-transcribe-live.
//
// Our own voice-activity detection decides where each utterance ("turn")
// starts and ends. For the turn on the wire we send activityStart, stream
// 16 kHz PCM while the person speaks, then activityEnd. The server streams back
//   serverContent.interimInputTranscription  - low-latency text while speaking
//   serverContent.inputTranscription         - finalized text (finished=true at the end)
//
// Only ONE turn is on the wire at a time; later turns are buffered locally and
// sent as soon as the previous one is finalized. That keeps results matched to
// the right utterance. Every turn keeps its audio until it is finalized, so if
// the connection drops (or hits its time limit) we reconnect and replay it.

import { bytesToBase64 } from './wav.js';

const WS_BASE = 'wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage';
const API_VERSIONS = ['v1', 'v1beta'];
const CONNECT_TIMEOUT_MS = 8000;
const CHUNK_SAMPLES = 1600; // stream audio every ~100 ms
const MAX_MESSAGE_SAMPLES = 8000; // split buffered audio into <= 0.5 s messages
const QUIET_MS = 1500; // finalize this long after the last final chunk (if no finished flag)
const EMPTY_TIMEOUT_MS = 2500; // nothing at all came back for the turn
const FINAL_TIMEOUT_MS = 6000; // text came back but was never finalized
const ROTATE_AFTER_MS = 8 * 60 * 1000; // sessions are time-limited: renew while idle
const MAX_RECONNECTS = 3;

export class LiveError extends Error {
  constructor(message, { fatal = false, nextVersion = false, stage = '' } = {}) {
    super(message);
    this.name = 'LiveError';
    this.fatal = fatal;
    this.nextVersion = nextVersion;
    this.stage = stage;
  }
}

function normalize(s) {
  return String(s || '').replace(/[\s、。，．,.!?！？「」"'・]/g, '');
}

async function readMessage(data) {
  let text = data;
  if (data instanceof Blob) text = await data.text();
  else if (data instanceof ArrayBuffer) text = new TextDecoder().decode(data);
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function describeClose(ev) {
  const reason = ev?.reason || '';
  if (/API key not valid|API_KEY_INVALID/i.test(reason)) return 'API キーが無効です';
  if (/quota|RESOURCE_EXHAUSTED/i.test(reason)) return 'Live API の利用上限に達しました';
  if (/not found|not supported|NOT_FOUND/i.test(reason)) return `モデルが Live API で利用できません（${reason}）`;
  return reason ? `接続が切れました：${reason}` : `接続が切れました（code ${ev?.code ?? '?'}）`;
}

function encodeFrames(frames) {
  let total = 0;
  for (const f of frames) total += f.length;
  const payloads = [];
  let buf = new Int16Array(Math.min(total, MAX_MESSAGE_SAMPLES));
  let n = 0;
  let left = total;
  for (const f of frames) {
    for (let i = 0; i < f.length; i++) {
      const s = Math.max(-1, Math.min(1, f[i]));
      buf[n++] = s < 0 ? s * 0x8000 : s * 0x7fff;
      left--;
      if (n === buf.length) {
        payloads.push(bytesToBase64(new Uint8Array(buf.buffer)));
        buf = new Int16Array(Math.min(left, MAX_MESSAGE_SAMPLES));
        n = 0;
      }
    }
  }
  return payloads;
}

export class LiveTranscriber {
  /**
   * @param {object} o
   * @param {string} o.apiKey
   * @param {string} o.model                e.g. gemini-3.5-transcribe-live
   * @param {string[]} [o.languageCodes]    BCP-47; empty = automatic detection
   * @param {string[]} [o.customVocabulary]
   * @param {'SMART'|'VERBATIM'} [o.mode]
   * @param {(id: string, text: string) => void} [o.onInterim]
   * @param {(id: string, text: string, info: {timedOut: boolean, hadInterim: boolean}) => void} [o.onFinal]
   * @param {(id: string, reason: string) => void} [o.onTurnFailed]
   * @param {(status: string, message?: string) => void} [o.onStatus]
   *        connecting | ready | reconnecting | failed | closed
   */
  constructor(o) {
    this.o = o;
    this.turns = [];
    this.conn = null;
    this.config = null; // the API version + setup that worked, reused on reconnect
    this.status = 'idle';
    this.dead = false;
    this.closing = false;
    this.draining = false;
    this.reconnects = 0;
    this.reconnectTimer = null;
  }

  get busy() {
    return this.turns.length > 0;
  }

  get variant() {
    return this.config?.variant.label || '';
  }

  get apiVersion() {
    return this.config?.version || '';
  }

  // =================================================================== API

  async start() {
    this._setStatus('connecting');
    try {
      await this._connect();
    } catch (err) {
      this._die(err.message || String(err));
      throw err;
    }
  }

  startTurn(id) {
    if (this.dead || this.closing) {
      this.o.onTurnFailed?.(id, 'unavailable');
      return;
    }
    this.turns.push({
      id, frames: [], framesLen: 0, sent: [], startSent: false, ended: false, endSent: false,
      final: '', interim: '', sawInterim: false, modelText: '', timers: [],
    });
    this._maybeRotate();
    this._pump();
  }

  appendAudio(samples) {
    const turn = this.turns[this.turns.length - 1];
    if (!turn || turn.ended || !samples?.length) return;
    turn.frames.push(samples);
    turn.framesLen += samples.length;
    if (turn === this.turns[0]) this._pump();
  }

  endTurn(id) {
    const turn = this.turns.find((t) => t.id === id);
    if (!turn) return;
    turn.ended = true;
    this._pump();
  }

  /** Let in-flight turns finish (up to maxMs), then close. */
  closeWhenIdle(maxMs = 9000) {
    this.draining = true;
    if (!this.busy) {
      this.close();
      return;
    }
    setTimeout(() => this.close(), maxMs);
  }

  /** Close now. Turns still waiting for a result are reported as failed. */
  close() {
    if (this.closing && !this.turns.length && !this.conn) return;
    this.closing = true;
    clearTimeout(this.reconnectTimer);
    this._dropConnection();
    this._failAll('closed');
    this._setStatus('closed');
  }

  // ============================================================ connection

  _setStatus(status, message) {
    if (this.status === status && !message) return;
    this.status = status;
    this.o.onStatus?.(status, message);
  }

  _setupVariants() {
    const { model, languageCodes = [], customVocabulary = [], mode } = this.o;
    const name = `models/${String(model).trim().replace(/^models\//, '')}`;
    const langs = languageCodes.length ? { languageCodes } : {};
    const full = { ...langs };
    if (customVocabulary.length) full.customVocabulary = customVocabulary;
    if (mode) full.mode = mode;
    const manual = { automaticActivityDetection: { disabled: true } };
    return [
      {
        label: 'full',
        manual: true,
        setup: {
          model: name,
          generationConfig: { responseModalities: ['TEXT'] },
          inputAudioTranscription: full,
          realtimeInputConfig: manual,
        },
      },
      {
        label: 'basic',
        manual: true,
        setup: { model: name, inputAudioTranscription: { ...langs }, realtimeInputConfig: manual },
      },
      {
        label: 'server-vad',
        manual: false,
        setup: { model: name, generationConfig: { responseModalities: ['TEXT'] }, inputAudioTranscription: { ...langs } },
      },
    ];
  }

  async _connect() {
    const versions = this.config ? [this.config.version] : API_VERSIONS;
    let lastError = null;
    for (const version of versions) {
      const variants = this.config ? [this.config.variant] : this._setupVariants();
      for (const variant of variants) {
        if (this.closing) throw new LiveError('閉じられました');
        try {
          const ws = await this._open(version, variant);
          if (this.closing) {
            ws.close(1000);
            throw new LiveError('閉じられました');
          }
          this.config = { version, variant };
          this.conn = { ws, connectedAt: Date.now(), goAway: false, manual: variant.manual };
          this._setStatus('ready');
          this._prepareReplay();
          this._pump();
          return;
        } catch (err) {
          lastError = err;
          if (err.fatal) throw err;
          if (err.stage === 'handshake' || err.nextVersion) break; // try the next API version
        }
      }
    }
    throw lastError || new LiveError('Live API に接続できませんでした');
  }

  _open(version, variant) {
    return new Promise((resolve, reject) => {
      const url = `${WS_BASE}.${version}.GenerativeService.BidiGenerateContent?key=${encodeURIComponent(this.o.apiKey)}`;
      let ws;
      try {
        ws = new WebSocket(url);
      } catch (err) {
        reject(new LiveError(String(err?.message || err), { stage: 'handshake' }));
        return;
      }
      let opened = false;
      let settled = false;

      const fail = (message, extra = {}) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        ws.onopen = ws.onmessage = ws.onclose = ws.onerror = null;
        try {
          ws.close();
        } catch {
          /* ignore */
        }
        reject(new LiveError(message, { ...extra, stage: opened ? 'setup' : 'handshake' }));
      };
      const timer = setTimeout(() => fail('Live API の応答がありません（タイムアウト）'), CONNECT_TIMEOUT_MS);

      ws.onopen = () => {
        opened = true;
        ws.send(JSON.stringify({ setup: variant.setup }));
      };
      ws.onerror = () => {
        /* a close event always follows */
      };
      ws.onclose = (ev) => {
        const message = describeClose(ev);
        fail(message, {
          fatal: /API キーが無効|利用上限/.test(message),
          nextVersion: /API version/i.test(ev?.reason || ''),
        });
      };
      ws.onmessage = async (ev) => {
        const msg = await readMessage(ev.data);
        if (!msg?.setupComplete || settled) return;
        settled = true;
        clearTimeout(timer);
        ws.onmessage = async (e) => {
          const m = await readMessage(e.data);
          if (m && this.conn?.ws === ws) this._onMessage(m);
        };
        ws.onclose = (e) => this._onClose(ws, e);
        resolve(ws);
      };
    });
  }

  _dropConnection() {
    const conn = this.conn;
    this.conn = null;
    if (!conn) return;
    conn.ws.onmessage = conn.ws.onclose = conn.ws.onerror = null;
    try {
      conn.ws.close(1000, 'client closed');
    } catch {
      /* ignore */
    }
  }

  // Reconnect; results still arriving on the old connection are ignored.
  _reconnect(reason, { planned = false } = {}) {
    this._dropConnection();
    if (this.closing || this.dead) return;
    if (this.draining && !this.busy) {
      this.close();
      return;
    }
    if (!planned) {
      if (this.reconnects >= MAX_RECONNECTS) {
        this._die(reason);
        return;
      }
      this.reconnects++;
    }
    this._setStatus('reconnecting', planned ? undefined : reason);
    const delay = planned || this.reconnects <= 1 ? 0 : 700 * 2 ** (this.reconnects - 2);
    clearTimeout(this.reconnectTimer);
    this.reconnectTimer = setTimeout(() => {
      this._connect().catch((err) => {
        if (err.fatal || this.reconnects >= MAX_RECONNECTS) this._die(err.message);
        else this._reconnect(err.message);
      });
    }, delay);
  }

  _onClose(ws, ev) {
    if (this.conn?.ws !== ws) return;
    this.conn = null;
    if (this.closing) return;
    const message = describeClose(ev);
    if (/API キーが無効|利用上限/.test(message)) this._die(message);
    else if (this.draining && !this.busy) this.close();
    else this._reconnect(message);
  }

  _maybeRotate() {
    const conn = this.conn;
    const head = this.turns[0];
    if (!conn || (head && head.startSent)) return;
    if (conn.goAway || Date.now() - conn.connectedAt > ROTATE_AFTER_MS) this._reconnect('rotate', { planned: true });
  }

  _die(message) {
    if (this.dead) return;
    this.dead = true;
    clearTimeout(this.reconnectTimer);
    this._dropConnection();
    this._failAll('unavailable');
    this._setStatus('failed', message);
  }

  _failAll(reason) {
    const pending = this.turns;
    this.turns = [];
    for (const t of pending) {
      this._clearTimers(t);
      this.o.onTurnFailed?.(t.id, reason);
    }
  }

  // ============================================================== sending

  _send(obj) {
    const ws = this.conn?.ws;
    if (!ws || ws.readyState !== WebSocket.OPEN) return false;
    ws.send(JSON.stringify(obj));
    return true;
  }

  _sendAudio(payload) {
    this._send({ realtimeInput: { audio: { data: payload, mimeType: 'audio/pcm;rate=16000' } } });
  }

  // After (re)connecting, the head turn starts over from its stored audio.
  _prepareReplay() {
    const head = this.turns[0];
    if (!head) return;
    this._clearTimers(head);
    head.startSent = false;
    head.endSent = false;
    head.final = '';
    head.interim = '';
    head.modelText = '';
  }

  _pump() {
    const conn = this.conn;
    const head = this.turns[0];
    if (!conn || !head || conn.ws.readyState !== WebSocket.OPEN) return;

    if (!head.startSent) {
      if (conn.manual) this._send({ realtimeInput: { activityStart: {} } });
      head.startSent = true;
      for (const payload of head.sent) this._sendAudio(payload);
    }
    if (head.framesLen >= CHUNK_SAMPLES || (head.ended && head.framesLen)) {
      const payloads = encodeFrames(head.frames);
      head.frames = [];
      head.framesLen = 0;
      for (const payload of payloads) {
        head.sent.push(payload);
        this._sendAudio(payload);
      }
    }
    if (head.ended && !head.endSent) {
      this._send(conn.manual ? { realtimeInput: { activityEnd: {} } } : { realtimeInput: { audioStreamEnd: true } });
      head.endSent = true;
      head.timers.push(
        setTimeout(() => {
          if (!head.sawInterim && !head.final && !head.modelText) this._finalizeHead(head, true);
        }, EMPTY_TIMEOUT_MS),
        setTimeout(() => this._finalizeHead(head, true), FINAL_TIMEOUT_MS),
      );
      if (head.final) this._armQuiet(head);
    }
  }

  // ============================================================ receiving

  _display(turn) {
    if (!turn.interim) return turn.final;
    // Interim may be the full hypothesis or only the not-yet-final remainder.
    return normalize(turn.interim).startsWith(normalize(turn.final)) ? turn.interim : turn.final + turn.interim;
  }

  _onMessage(msg) {
    if (msg.goAway && this.conn) this.conn.goAway = true;
    const sc = msg.serverContent;
    const head = this.turns[0];
    if (!sc || !head || !head.startSent) return;

    const interim = sc.interimInputTranscription;
    if (interim && typeof interim.text === 'string') {
      head.interim = interim.text;
      if (interim.text) head.sawInterim = true;
      this.o.onInterim?.(head.id, this._display(head));
    }

    const fin = sc.inputTranscription;
    if (fin && (typeof fin.text === 'string' || fin.finished)) {
      head.final += fin.text || '';
      head.interim = '';
      this.o.onInterim?.(head.id, this._display(head));
      if (fin.finished && head.endSent) {
        this._finalizeHead(head, false);
        return;
      }
      if (head.endSent) this._armQuiet(head);
    }

    // A dedicated transcription model might answer as model text instead.
    const parts = sc.modelTurn?.parts;
    if (Array.isArray(parts)) {
      head.modelText += parts.filter((p) => typeof p.text === 'string' && !p.thought).map((p) => p.text).join('');
    }

    if (sc.turnComplete && head.endSent && (head.final || head.modelText)) this._armQuiet(head, 300);
  }

  _armQuiet(turn, ms = QUIET_MS) {
    clearTimeout(turn.quiet);
    turn.quiet = setTimeout(() => this._finalizeHead(turn, false), ms);
  }

  _clearTimers(turn) {
    clearTimeout(turn.quiet);
    for (const t of turn.timers) clearTimeout(t);
    turn.timers = [];
  }

  _finalizeHead(turn, timedOut) {
    if (this.turns[0] !== turn) return;
    this.turns.shift();
    this._clearTimers(turn);
    const text = (turn.final || turn.modelText).trim();
    if (!timedOut && text) this.reconnects = 0;
    this.o.onFinal?.(turn.id, text, { timedOut, hadInterim: turn.sawInterim });

    if (this.draining && !this.busy) {
      this.close();
      return;
    }
    if (timedOut) {
      // Late results for this turn could otherwise land on the next one.
      this._reconnect('リアルタイムの結果が届きませんでした', { planned: !turn.sawInterim });
      return;
    }
    this._maybeRotate();
    this._pump();
  }
}

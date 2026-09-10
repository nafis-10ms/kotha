// Offscreen document: the only place in the extension allowed to touch
// getUserMedia. Captures mic audio, applies a close-talk noise gate so only
// the near speaker is transmitted, streams it to the Soniox real-time
// WebSocket API, and relays transcription tokens back through the background
// service worker to the active tab's content script.

const SONIOX_WS_URL = "wss://stt-rt.soniox.com/transcribe-websocket";
const MODEL = "stt-rt-v5";
const MAX_RECONNECT_ATTEMPTS = 4;
const RECONNECT_BASE_DELAY_MS = 800;
const CONNECT_TIMEOUT_MS = 8000;
// Holding the mic briefly after a session makes back-to-back dictation start
// instantly instead of paying device-init cost (often 300-800ms) every time.
const MIC_IDLE_RELEASE_MS = 60000;
const MAX_BUFFERED_CHUNKS = 150; // ~30s at 200ms per chunk

// Close-talk gate. Open/close thresholds differ (hysteresis) so the gate does
// not chatter on syllable boundaries, and it stays open for HANGOVER_MS after
// the level drops so word endings are never clipped.
const GATE_PROFILES = {
  off: null,
  relaxed: { open: -48, close: -54 },
  balanced: { open: -38, close: -44 },
  strict: { open: -28, close: -34 },
};
const GATE_HANGOVER_MS = 700;
const GATE_TICK_MS = 50;
const LEVEL_POST_MS = 120;

// Safety stops. Without these a forgotten session keeps the mic open and keeps
// billing Soniox for silence — a real cost and privacy problem on a call floor.
const SILENCE_STOP_MS = 120000; // no speech for 2 min
const MAX_SESSION_MS = 900000; // hard cap of 15 min per session

let mediaStream = null; // raw device stream
let gatedStream = null; // what actually gets recorded
let recorder = null;
let ws = null;
let apiKeyInUse = "";
let languageHintsInUse = [];
let languageStrictInUse = false;
let speakerLockInUse = false;
let gateProfile = GATE_PROFILES.balanced;

let audioCtx = null;
let sourceNode = null;
let gainNode = null;
let analyser = null;
let destNode = null;
let analyserBuf = null;
let gateTimer = null;
let gateOpen = false;
let lastAboveAt = 0;
let lastLevelPost = 0;
let lastVoiceAt = 0;
let sessionStartedAt = 0;

let wantActive = false; // user has asked to dictate (survives transient reconnects)
let userStopping = false; // explicit STOP requested — never reconnect
let reconnectAttempt = 0;
let reconnectTimer = null;
let connectTimer = null;
let micIdleTimer = null;
let socketReady = false;
let announcedReady = false;
let pendingChunks = []; // audio captured before the socket is ready to accept it

function post(message) {
  try {
    const p = chrome.runtime.sendMessage({ target: "offscreen-relay", ...message });
    if (p && typeof p.catch === "function") p.catch(() => {});
  } catch {}
}

// ------------------------------------------------------------------ microphone

async function ensureMic() {
  clearTimeout(micIdleTimer);
  micIdleTimer = null;

  if (mediaStream && mediaStream.getAudioTracks().some((t) => t.readyState === "live")) {
    return true; // still warm from a recent session — no device init needed
  }

  // An offscreen document has no visible surface, so Chrome cannot show it the
  // microphone permission prompt — getUserMedia would just fail silently.
  // Verify the grant already exists and hand off to permission.html if not.
  try {
    const state = (await navigator.permissions.query({ name: "microphone" })).state;
    if (state !== "granted") {
      post({ type: "NEED_MIC_PERMISSION" });
      return false;
    }
  } catch {
    // Permissions API unavailable — fall through and let getUserMedia decide.
  }

  try {
    mediaStream = await navigator.mediaDevices.getUserMedia({
      audio: {
        channelCount: 1,
        echoCancellation: true,
        noiseSuppression: true,
        // Deliberately OFF. AGC raises the gain while the near speaker is
        // silent, lifting nearby colleagues' speech to transcribable levels —
        // the exact problem in an open call-centre floor. Leaving it off keeps
        // the loudness gap that the close-talk gate below depends on.
        autoGainControl: false,
      },
    });
    return true;
  } catch (err) {
    if (err && (err.name === "NotAllowedError" || err.name === "SecurityError")) {
      post({ type: "NEED_MIC_PERMISSION" });
    } else {
      post({
        type: "ERROR",
        message: "Microphone unavailable: " + (err ? err.message : "unknown error"),
      });
    }
    return false;
  }
}

function scheduleMicRelease() {
  clearTimeout(micIdleTimer);
  micIdleTimer = setTimeout(releaseMic, MIC_IDLE_RELEASE_MS);
}

function releaseMic() {
  clearTimeout(micIdleTimer);
  micIdleTimer = null;
  teardownAudioGraph();
  if (mediaStream) {
    mediaStream.getTracks().forEach((t) => t.stop());
    mediaStream = null;
  }
}

// ------------------------------------------------------------- close-talk gate

function setupAudioGraph() {
  if (audioCtx && sourceNode) return;
  audioCtx = new AudioContext();
  sourceNode = audioCtx.createMediaStreamSource(mediaStream);

  analyser = audioCtx.createAnalyser();
  analyser.fftSize = 1024;
  analyserBuf = new Float32Array(analyser.fftSize);

  gainNode = audioCtx.createGain();
  destNode = audioCtx.createMediaStreamDestination();

  // Measure the raw signal, but transmit through the gate.
  sourceNode.connect(analyser);
  sourceNode.connect(gainNode);
  gainNode.connect(destNode);

  gateOpen = !gateProfile;
  gainNode.gain.value = gateOpen ? 1 : 0;
  gatedStream = destNode.stream;

  if (audioCtx.state === "suspended") audioCtx.resume().catch(() => {});
}

function teardownAudioGraph() {
  stopGateLoop();
  try {
    if (sourceNode) sourceNode.disconnect();
    if (gainNode) gainNode.disconnect();
    if (audioCtx) audioCtx.close();
  } catch {}
  audioCtx = sourceNode = gainNode = analyser = destNode = null;
  analyserBuf = null;
  gatedStream = null;
}

function setGate(open) {
  if (gateOpen === open || !gainNode || !audioCtx) return;
  gateOpen = open;
  // Ramp rather than switch, so the gate doesn't add clicks to the audio.
  gainNode.gain.setTargetAtTime(open ? 1 : 0, audioCtx.currentTime, 0.015);
}

function startGateLoop() {
  stopGateLoop();
  if (!analyser) return;
  lastAboveAt = 0;
  gateTimer = setInterval(() => {
    if (!analyser) return;
    analyser.getFloatTimeDomainData(analyserBuf);
    let sum = 0;
    for (let i = 0; i < analyserBuf.length; i++) sum += analyserBuf[i] * analyserBuf[i];
    const rms = Math.sqrt(sum / analyserBuf.length);
    const db = 20 * Math.log10(rms || 1e-8);

    const now = Date.now();
    // Speech reference level: the gate's own threshold when gating, otherwise
    // a fixed floor so the idle timeout still works with the gate off.
    if (db >= (gateProfile ? gateProfile.open : -45)) lastVoiceAt = now;

    if (!gateProfile) {
      setGate(true);
    } else if (db >= gateProfile.open) {
      lastAboveAt = now;
      setGate(true);
    } else if (db < gateProfile.close && now - lastAboveAt > GATE_HANGOVER_MS) {
      setGate(false);
    }

    if (now - lastVoiceAt > SILENCE_STOP_MS) {
      post({ type: "AUTO_STOPPED", reason: "No speech for 2 minutes — microphone released." });
      stop();
      return;
    }
    if (now - sessionStartedAt > MAX_SESSION_MS) {
      post({ type: "AUTO_STOPPED", reason: "Session reached the 15 minute limit." });
      stop();
      return;
    }

    if (now - lastLevelPost > LEVEL_POST_MS) {
      lastLevelPost = now;
      post({ type: "LEVEL", db: Math.round(db), open: gateOpen, gated: !!gateProfile });
    }
  }, GATE_TICK_MS);
}

function stopGateLoop() {
  if (gateTimer) clearInterval(gateTimer);
  gateTimer = null;
}

// ---------------------------------------------------------------- session flow

async function start(opts) {
  clearTimeout(reconnectTimer);
  userStopping = false;
  wantActive = true;
  reconnectAttempt = 0;
  announcedReady = false;
  apiKeyInUse = opts.apiKey;
  languageHintsInUse = Array.isArray(opts.languageHints) ? opts.languageHints : [];
  languageStrictInUse = !!opts.languageStrict;
  speakerLockInUse = !!opts.speakerLock;
  gateProfile =
    opts.gateMode && Object.prototype.hasOwnProperty.call(GATE_PROFILES, opts.gateMode)
      ? GATE_PROFILES[opts.gateMode]
      : GATE_PROFILES.balanced;

  sessionStartedAt = Date.now();
  lastVoiceAt = sessionStartedAt;

  post({ type: "STATUS", status: "connecting" });

  // Socket setup and mic acquisition are independent. Running them together
  // removes the device-init delay from the critical path.
  openSocket();
  const micOk = await ensureMic();
  if (!micOk) {
    wantActive = false;
    closeSocket();
    post({ type: "STATUS", status: "stopped" });
    return;
  }
  if (!wantActive) return;

  setupAudioGraph();
  startGateLoop();
  startRecorder();
}

function openSocket() {
  if (!wantActive) return;
  closeSocket();
  socketReady = false;
  pendingChunks = [];

  ws = new WebSocket(SONIOX_WS_URL);
  ws.binaryType = "arraybuffer";

  clearTimeout(connectTimer);
  connectTimer = setTimeout(() => {
    if (ws && ws.readyState === WebSocket.CONNECTING) {
      post({
        type: "ERROR",
        message: "Timed out connecting to Soniox. Check your connection and try again.",
      });
      wantActive = false;
      closeSocket();
      finishStop();
    }
  }, CONNECT_TIMEOUT_MS);

  ws.onopen = () => {
    clearTimeout(connectTimer);
    reconnectAttempt = 0;
    const config = {
      api_key: apiKeyInUse,
      model: MODEL,
      audio_format: "auto",
      enable_endpoint_detection: true,
      // Tags every token with its detected language and is what drives
      // reliable mid-sentence switching. Soniox's own LiveKit plugin
      // defaults this on; the raw WebSocket API defaults it off.
      enable_language_identification: true,
    };
    // Separates voices so the content script can keep only the primary
    // speaker's tokens and discard nearby colleagues who got through the gate.
    if (speakerLockInUse) config.enable_speaker_diarization = true;
    // Hints bias recognition; omitting them entirely is fully automatic
    // detection. `language_hints_strict` restricts to the listed languages,
    // so it is only ever set by the single-language modes.
    if (languageHintsInUse.length > 0) {
      config.language_hints = languageHintsInUse;
      if (languageStrictInUse) config.language_hints_strict = true;
    }
    ws.send(JSON.stringify(config));
    socketReady = true;

    // Mic may have finished first (audio already buffered) or may still be
    // initialising — cover both.
    startRecorder();
    flushPending();
    maybeAnnounceReady();
  };

  ws.onmessage = (event) => {
    let data;
    try {
      data = JSON.parse(event.data);
    } catch {
      return;
    }
    if (data.error_message) {
      post({ type: "ERROR", message: data.error_message });
      return;
    }
    if (Array.isArray(data.tokens) && data.tokens.length > 0) {
      post({ type: "TOKENS", tokens: data.tokens, speakerLock: speakerLockInUse });
    }
    if (data.finished) finishStop();
  };

  ws.onerror = () => {
    // onclose fires right after; reconnect logic lives there.
  };

  ws.onclose = () => {
    clearTimeout(connectTimer);
    socketReady = false;
    // The recorder must restart per connection: each MediaRecorder run emits
    // the container header in its first chunk, and a fresh socket needs it.
    stopRecorderOnly();
    if (userStopping || !wantActive) {
      finishStop();
      return;
    }
    attemptReconnect();
  };
}

function closeSocket() {
  clearTimeout(connectTimer);
  if (ws) {
    ws.onopen = ws.onmessage = ws.onerror = ws.onclose = null;
    try {
      ws.close();
    } catch {}
    ws = null;
  }
  socketReady = false;
}

function maybeAnnounceReady() {
  if (announcedReady) return;
  if (socketReady && recorder) {
    announcedReady = true;
    post({ type: "STATUS", status: "listening" });
  }
}

function attemptReconnect() {
  if (reconnectAttempt >= MAX_RECONNECT_ATTEMPTS) {
    post({ type: "ERROR", message: "Lost connection to Soniox. Click the mic to try again." });
    wantActive = false;
    finishStop();
    return;
  }
  reconnectAttempt += 1;
  post({ type: "STATUS", status: "reconnecting", attempt: reconnectAttempt });
  const delay = RECONNECT_BASE_DELAY_MS * Math.pow(2, reconnectAttempt - 1);
  reconnectTimer = setTimeout(() => {
    if (wantActive) openSocket();
  }, delay);
}

// ------------------------------------------------------------------- recording

function pickMimeType() {
  const candidates = ["audio/webm;codecs=opus", "audio/webm", "audio/ogg;codecs=opus"];
  for (const c of candidates) {
    if (window.MediaRecorder && MediaRecorder.isTypeSupported(c)) return c;
  }
  return null;
}

function sendOrBuffer(buf) {
  if (socketReady && ws && ws.readyState === WebSocket.OPEN) {
    ws.send(buf);
    return;
  }
  // Keep the earliest audio (it carries the stream header) and stop adding
  // once the buffer is full rather than dropping from the front.
  if (pendingChunks.length < MAX_BUFFERED_CHUNKS) pendingChunks.push(buf);
}

function flushPending() {
  if (!socketReady || !ws || ws.readyState !== WebSocket.OPEN) return;
  for (const buf of pendingChunks) {
    try {
      ws.send(buf);
    } catch {}
  }
  pendingChunks = [];
}

function startRecorder() {
  const source = gatedStream || mediaStream;
  if (recorder || !source || !wantActive) return;
  try {
    const mimeType = pickMimeType();
    recorder = new MediaRecorder(source, mimeType ? { mimeType } : undefined);
    recorder.ondataavailable = (event) => {
      if (!event.data || event.data.size === 0) return;
      // Capture starts before the socket is ready, so early speech is buffered
      // and flushed on connect rather than being lost.
      event.data.arrayBuffer().then(sendOrBuffer).catch(() => {});
    };
    recorder.start(200);
    maybeAnnounceReady();
  } catch (err) {
    post({ type: "ERROR", message: "Failed to start audio recorder: " + err.message });
  }
}

function stopRecorderOnly() {
  if (recorder && recorder.state !== "inactive") {
    try {
      recorder.stop();
    } catch {}
  }
  recorder = null;
}

// ---------------------------------------------------------------------- teardown

function finishStop() {
  clearTimeout(reconnectTimer);
  clearTimeout(connectTimer);
  wantActive = false;
  announcedReady = false;
  stopGateLoop();
  stopRecorderOnly();
  pendingChunks = [];
  closeSocket();
  // Keep the mic warm for a short while so the next dictation starts instantly.
  scheduleMicRelease();
  post({ type: "STATUS", status: "stopped" });
}

async function stop() {
  userStopping = true;
  wantActive = false;
  clearTimeout(reconnectTimer);
  stopGateLoop();

  if (recorder && recorder.state !== "inactive") {
    // Flush a final chunk, then tell Soniox we're done so trailing final
    // tokens come back before we tear the socket down.
    try {
      recorder.requestData();
    } catch {}
    stopRecorderOnly();
  }
  flushPending();
  if (ws && ws.readyState === WebSocket.OPEN) ws.send("");

  setTimeout(finishStop, 700);
}

chrome.runtime.onMessage.addListener((message) => {
  if (!message || message.target !== "offscreen") return;
  if (message.type === "START") {
    start(message);
  } else if (message.type === "STOP") {
    stop();
  }
});

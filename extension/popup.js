const $ = (id) => document.getElementById(id);

const apiKeyEl = $("apiKey");
const statusEl = $("status");
const toggleEye = $("toggleEye");
const posGrid = $("posGrid");
const dragTip = $("dragTip");
const langSeg = $("langSeg");
const gateSeg = $("gateSeg");
const langCap = $("langCap");
const gateCap = $("gateCap");
const speakerLockEl = $("speakerLock");
const testBtn = $("testKey");
const testResult = $("testResult");
const advToggle = $("advToggle");
const adv = $("adv");
const statusPill = $("statusPill");
const statusText = $("statusText");

const DEFAULTS = { position: "top-right", language: "bn_en", gate: "balanced" };
const REALTIME_MODEL = "stt-rt-v5";

// Captions carry the explanation so the controls themselves stay compact.
const LANG_CAPTIONS = {
  bn_en: "Hints both languages. Switches mid-sentence.",
  bn: "Restricted to Bengali.",
  en: "Restricted to English.",
};
const GATE_CAPTIONS = {
  off: "Sends all audio, including nearby voices.",
  relaxed: "Picks up quieter speech.",
  balanced: "Recommended for a busy floor.",
  strict: "Close speech only. Best with a headset.",
};

function flash(text) {
  statusEl.textContent = text;
  setTimeout(() => (statusEl.textContent = ""), 1700);
}

function select(container, attr, value) {
  container.querySelectorAll("button").forEach((b) => {
    b.classList.toggle("active", b.dataset[attr] === value);
  });
}

// ------------------------------------------------------------ status pill

async function refreshStatus() {
  const { apiKey } = await chrome.storage.local.get(["apiKey"]);

  // Key first: without it nothing works, and it's the one thing a new install
  // always needs, so it outranks the microphone prompt.
  if (!apiKey) {
    statusPill.className = "pill warn";
    statusText.textContent = "Add API key";
    statusPill.onclick = () => {
      setAdvanced(true);
      apiKeyEl.focus();
    };
    return;
  }

  let mic = "prompt";
  try {
    mic = (await navigator.permissions.query({ name: "microphone" })).state;
  } catch {}

  if (mic !== "granted") {
    statusPill.className = "pill warn";
    statusText.textContent = "Allow microphone";
    statusPill.onclick = () => {
      chrome.tabs.create({ url: chrome.runtime.getURL("permission.html") });
      window.close();
    };
    return;
  }

  statusPill.className = "pill ok";
  statusText.textContent = "Ready";
  statusPill.onclick = null;
}

// --------------------------------------------------------------- controls

langSeg.addEventListener("click", async (e) => {
  const b = e.target.closest("button");
  if (!b) return;
  select(langSeg, "mode", b.dataset.mode);
  langCap.textContent = LANG_CAPTIONS[b.dataset.mode];
  await chrome.storage.local.set({ languageMode: b.dataset.mode });
  flash("Language updated.");
});

gateSeg.addEventListener("click", async (e) => {
  const b = e.target.closest("button");
  if (!b) return;
  select(gateSeg, "gate", b.dataset.gate);
  gateCap.textContent = GATE_CAPTIONS[b.dataset.gate];
  await chrome.storage.local.set({ gateMode: b.dataset.gate });
  flash("Voice focus updated.");
});

speakerLockEl.addEventListener("change", async () => {
  await chrome.storage.local.set({ speakerLock: speakerLockEl.checked });
  flash(speakerLockEl.checked ? "Locked to your voice." : "Other speakers allowed.");
});

function renderPosition(pos) {
  select(posGrid, "pos", pos);
  const custom = pos === "custom";
  dragTip.innerHTML = custom
    ? "Using a custom dragged position. Pick a preset to reset it."
    : "Tip: drag the mic on any page to place it exactly where you want.";
}

posGrid.addEventListener("click", async (e) => {
  const b = e.target.closest(".pos");
  if (!b) return;
  renderPosition(b.dataset.pos);
  await chrome.storage.local.set({ iconPosition: b.dataset.pos, customPos: null });
  flash("Placement updated.");
});

// -------------------------------------------------------------- advanced

function setAdvanced(open) {
  adv.hidden = !open;
  advToggle.setAttribute("aria-expanded", String(open));
}
advToggle.addEventListener("click", () => {
  setAdvanced(adv.hidden);
});

toggleEye.addEventListener("click", () => {
  const show = apiKeyEl.type === "password";
  apiKeyEl.type = show ? "text" : "password";
  toggleEye.textContent = show ? "hide" : "show";
});

$("save").addEventListener("click", async () => {
  const apiKey = apiKeyEl.value.trim();
  await chrome.storage.local.set({ apiKey });
  flash(apiKey ? "Saved." : "No key set — dictation disabled.");
  refreshStatus();
});

function setResult(kind, text) {
  testResult.className = "result " + kind;
  testResult.textContent = "";
  if (kind === "busy") {
    const s = document.createElement("span");
    s.className = "spin";
    testResult.appendChild(s);
  }
  testResult.appendChild(document.createTextNode(text));
}

testBtn.addEventListener("click", async () => {
  const key = apiKeyEl.value.trim();
  if (!key) {
    setResult("bad", "Enter an API key first.");
    return;
  }
  testBtn.disabled = true;
  setResult("busy", "Checking…");
  try {
    // Lightweight authenticated call — confirms the key works and that the
    // realtime model this extension uses is actually available to it.
    const res = await fetch("https://api.soniox.com/v1/models", {
      headers: { Authorization: "Bearer " + key },
    });
    if (res.status === 401 || res.status === 403) {
      setResult("bad", "Key rejected by Soniox.");
      return;
    }
    if (!res.ok) {
      setResult("bad", `Soniox returned ${res.status}.`);
      return;
    }
    const data = await res.json();
    const ids = Array.isArray(data.models) ? data.models.map((m) => m.id) : [];
    if (ids.length && !ids.includes(REALTIME_MODEL)) {
      setResult("bad", `Valid, but ${REALTIME_MODEL} unavailable.`);
      return;
    }
    setResult("ok", `Key valid · ${REALTIME_MODEL} ready`);
  } catch (err) {
    setResult("bad", "Network error: " + (err && err.message ? err.message : "failed"));
  } finally {
    testBtn.disabled = false;
  }
});

// ------------------------------------------------------------------- init

async function load() {
  const cfg = await chrome.storage.local.get([
    "apiKey",
    "iconPosition",
    "languageMode",
    "gateMode",
    "speakerLock",
  ]);

  if (cfg.apiKey) apiKeyEl.value = cfg.apiKey;
  // First run: the key is the only blocking step, so don't make them find it.
  if (!cfg.apiKey) setAdvanced(true);

  const lang = cfg.languageMode || DEFAULTS.language;
  const gate = cfg.gateMode || DEFAULTS.gate;
  select(langSeg, "mode", lang);
  select(gateSeg, "gate", gate);
  langCap.textContent = LANG_CAPTIONS[lang];
  gateCap.textContent = GATE_CAPTIONS[gate];
  renderPosition(cfg.iconPosition || DEFAULTS.position);
  speakerLockEl.checked = !!cfg.speakerLock;

  refreshStatus();
}
load();

// Reflect a drag performed on a page while this popup is open.
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "local" && changes.iconPosition) {
    renderPosition(changes.iconPosition.newValue || DEFAULTS.position);
  }
});

// Background service worker: owns the offscreen document (mic capture + Soniox
// WebSocket) and relays messages between it and whichever tab/content script
// started dictation.

const OFFSCREEN_URL = "offscreen.html";
let creatingOffscreen = null;
let activeTabId = null; // tab currently receiving transcript updates

// Language modes. `language_hints_strict` restricts to one language and must
// never be used for code-switching — it is set only by the single-language
// modes, where restriction is the point.
const LANGUAGE_MODES = {
  // Default: bias toward Bengali + English, still free to switch mid-sentence.
  bn_en: { hints: ["bn", "en"], strict: false },
  bn: { hints: ["bn"], strict: true },
  en: { hints: ["en"], strict: true },
};
const DEFAULT_LANGUAGE_MODE = "bn_en";

async function getLanguageConfig() {
  const { languageMode } = await chrome.storage.local.get(["languageMode"]);
  return LANGUAGE_MODES[languageMode] || LANGUAGE_MODES[DEFAULT_LANGUAGE_MODE];
}

function openMicPermissionTab() {
  chrome.tabs.create({ url: chrome.runtime.getURL("permission.html") });
}

chrome.runtime.onInstalled.addListener(() => {
  // Prime microphone permission up front — the offscreen document that does
  // the actual capture can never show this prompt itself. permission.html
  // closes itself immediately if the grant already exists.
  openMicPermissionTab();
});

async function ensureOffscreenDocument() {
  const existing = await chrome.runtime.getContexts({
    contextTypes: ["OFFSCREEN_DOCUMENT"],
  });
  if (existing.length > 0) return;

  if (creatingOffscreen) {
    await creatingOffscreen;
    return;
  }

  creatingOffscreen = chrome.offscreen.createDocument({
    url: OFFSCREEN_URL,
    reasons: ["USER_MEDIA"],
    justification: "Capture microphone audio and stream it to Soniox for real-time transcription.",
  });
  try {
    await creatingOffscreen;
  } finally {
    creatingOffscreen = null;
  }
}

// The key is entered by the user in the popup and never ships with the
// extension, so there is no shared secret to leak or rotate.
async function getApiKey() {
  const { apiKey } = await chrome.storage.local.get(["apiKey"]);
  return apiKey || "";
}

function notifyTab(tabId, payload) {
  if (tabId == null) return;
  chrome.tabs.sendMessage(tabId, payload).catch(() => {});
}

function sendToOffscreen(payload) {
  const p = chrome.runtime.sendMessage(payload);
  if (p && typeof p.catch === "function") p.catch(() => {});
}

async function handleBackgroundMessage(message, sender) {
  if (message.type === "WARM_UP") {
    // Called when a text field is focused. Creating the offscreen document
    // costs a few hundred ms, so get it out of the way before the click.
    try {
      await ensureOffscreenDocument();
    } catch {}
    return { ok: true };
  }

  if (message.type === "START_DICTATION") {
    const newTabId = sender.tab ? sender.tab.id : message.tabId;

    // Only one capture session exists. Starting in a second tab must release
    // the first, or its UI sits on "Listening" forever with no audio behind it.
    if (activeTabId != null && activeTabId !== newTabId) {
      sendToOffscreen({ target: "offscreen", type: "STOP" });
      notifyTab(activeTabId, { target: "content", type: "STATUS", status: "stopped" });
    }
    activeTabId = newTabId;

    const apiKey = await getApiKey();
    if (!apiKey) {
      notifyTab(activeTabId, {
        target: "content",
        type: "ERROR",
        message: "Add your Soniox API key in the Kotha popup to start dictating.",
      });
      return { ok: false };
    }

    try {
      await ensureOffscreenDocument();
    } catch (err) {
      notifyTab(activeTabId, {
        target: "content",
        type: "ERROR",
        message: "Could not start the audio worker: " + err.message,
      });
      return { ok: false };
    }

    const lang = await getLanguageConfig();
    const { gateMode, speakerLock } = await chrome.storage.local.get([
      "gateMode",
      "speakerLock",
    ]);
    sendToOffscreen({
      target: "offscreen",
      type: "START",
      apiKey,
      languageHints: lang.hints,
      languageStrict: lang.strict,
      gateMode: gateMode || "balanced",
      speakerLock: !!speakerLock,
    });
    return { ok: true };
  }

  if (message.type === "STOP_DICTATION") {
    sendToOffscreen({ target: "offscreen", type: "STOP" });
    return { ok: true };
  }

  return { ok: false, error: "unknown message type" };
}

function handleOffscreenRelay(message) {
  if (message.type === "NEED_MIC_PERMISSION") {
    openMicPermissionTab();
    notifyTab(activeTabId, {
      target: "content",
      type: "ERROR",
      message:
        "Microphone permission needed — allow it in the tab that just opened, then click the mic again.",
    });
    return;
  }
  notifyTab(activeTabId, { ...message, target: "content" });
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message || typeof message !== "object") return false;

  if (message.target === "background") {
    // Only this branch answers, so only this branch keeps the channel open.
    handleBackgroundMessage(message, sender)
      .then(sendResponse)
      .catch((err) => sendResponse({ ok: false, error: String(err && err.message) }));
    return true;
  }

  if (message.target === "offscreen-relay") {
    handleOffscreenRelay(message);
  }
  return false;
});

// If the tab that started dictation navigates away or closes, stop the mic.
chrome.tabs.onRemoved.addListener((tabId) => {
  if (tabId === activeTabId) {
    sendToOffscreen({ target: "offscreen", type: "STOP" });
    activeTabId = null;
  }
});
chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (tabId === activeTabId && changeInfo.status === "loading") {
    sendToOffscreen({ target: "offscreen", type: "STOP" });
    activeTabId = null;
  }
});

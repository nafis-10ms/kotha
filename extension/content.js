// Content script: detects focus on editable fields, shows a floating mic
// button (Grammarly-style), and inserts dictated text as it is finalized.
// Tuned for robust Bengali/English code-switching dictation.

(() => {
  if (window.__kothaLoaded) return;
  window.__kothaLoaded = true;

  // Diagnostics are opt-in: this script runs on every page, so logging each
  // URL unconditionally would spam the console and record browsing activity.
  let debug = false;
  const log = (...args) => debug && console.log("[Kotha]", ...args);

  const EDITABLE_INPUT_TYPES = new Set([
    "text",
    "search",
    "email",
    "url",
    "tel",
    "number",
  ]);

  const BTN_SIZE = 34;
  const PANEL_WIDTH = 380;
  const DEFAULT_POSITION = "top-right";

  let activeField = null; // element currently eligible for dictation
  let dictating = false;
  let interimText = "";
  let recentFinalTail = "";
  let iconPosition = DEFAULT_POSITION;
  let customPos = null; // {x, y} viewport coords set by dragging the button
  let lastLanguage = ""; // most recent language Soniox tagged a token with
  let primarySpeaker = null; // first speaker of the session, when speaker lock is on

  const root = document.createElement("div");
  root.id = "kotha-root";
  const shadow = root.attachShadow({ mode: "open" });

  const FONT_STACK =
    '"Segoe UI", "Noto Sans Bengali", "Hind Siliguri", "Nirmala UI", Roboto, -apple-system, BlinkMacSystemFont, sans-serif';

  const style = document.createElement("style");
  style.textContent = `
    :host { all: initial; }
    .btn {
      position: fixed;
      width: ${BTN_SIZE}px;
      height: ${BTN_SIZE}px;
      border-radius: 50%;
      background: linear-gradient(155deg, #6d46d6, #5233ad);
      box-shadow: 0 2px 10px rgba(30,15,80,.35), 0 0 0 3px rgba(255,255,255,.9);
      display: none;
      align-items: center;
      justify-content: center;
      cursor: pointer;
      z-index: 2147483647;
      transition: opacity .12s ease, background .2s ease, box-shadow .2s ease;
      border: none;
      padding: 0;
      opacity: 0;
      touch-action: none;
    }
    .btn.show { opacity: 1; }
    .btn.dragging {
      cursor: grabbing;
      box-shadow: 0 6px 20px rgba(30,15,80,.55), 0 0 0 3px rgba(255,255,255,1);
      transition: none;
    }
    .btn:hover { box-shadow: 0 2px 14px rgba(30,15,80,.5), 0 0 0 3px rgba(255,255,255,1); }
    .btn.listening {
      background: linear-gradient(155deg, #f0564a, #d5352b);
      animation: pulse 1.5s ease-in-out infinite;
    }
    .btn.reconnecting {
      background: linear-gradient(155deg, #e0a33a, #c07f1f);
    }
    .btn svg { width: 17px; height: 17px; fill: #fff; pointer-events: none; }
    .btn .spinner {
      position: absolute;
      inset: -3px;
      border-radius: 50%;
      border: 2px solid transparent;
      border-top-color: rgba(255,255,255,.85);
      animation: spin .8s linear infinite;
      display: none;
    }
    .btn.reconnecting .spinner { display: block; }
    @keyframes spin { to { transform: rotate(360deg); } }
    @keyframes pulse {
      0% { box-shadow: 0 0 0 0 rgba(213,53,43,.5), 0 0 0 3px rgba(255,255,255,.9); }
      70% { box-shadow: 0 0 0 9px rgba(213,53,43,0), 0 0 0 3px rgba(255,255,255,.9); }
      100% { box-shadow: 0 0 0 0 rgba(213,53,43,0), 0 0 0 3px rgba(255,255,255,.9); }
    }
    .panel {
      position: fixed;
      max-width: ${PANEL_WIDTH}px;
      min-width: 190px;
      background: rgba(28,28,30,.92);
      -webkit-backdrop-filter: saturate(180%) blur(20px);
      backdrop-filter: saturate(180%) blur(20px);
      color: #f5f5f7;
      font: 13px/1.5 ${FONT_STACK};
      padding: 9px 11px;
      border-radius: 12px;
      box-shadow: 0 10px 30px rgba(0,0,0,.28), 0 0 0 .5px rgba(255,255,255,.12);
      display: none;
      z-index: 2147483647;
      pointer-events: none;
      white-space: pre-wrap;
      word-break: break-word;
      opacity: 0;
      transform: translateY(-2px);
      transition: opacity .16s ease, transform .16s ease;
    }
    .panel.show { opacity: 1; transform: translateY(0); }
    .panel-head {
      display: flex;
      align-items: center;
      gap: 6px;
      font-size: 11px;
      font-weight: 550;
      color: #98989f;
      margin-bottom: 3px;
    }
    .panel .dot {
      display: inline-block;
      width: 6px;
      height: 6px;
      border-radius: 50%;
      background: #f0564a;
      animation: blink 1.1s ease-in-out infinite;
      flex: none;
    }
    .panel.reconnecting .dot { background: #e0a33a; }
    .panel .badge {
      margin-left: auto;
      color: #8e8e93;
      font-size: 10.5px;
      font-weight: 550;
    }
    .panel .meter {
      height: 2px;
      border-radius: 1px;
      background: rgba(255,255,255,.12);
      overflow: hidden;
      margin: 1px 0 6px;
    }
    .panel .meter-fill {
      height: 100%;
      width: 0%;
      background: #34c759;
      border-radius: 1px;
      transition: width .1s linear, background .2s ease;
    }
    .panel .meter-fill.muted { background: rgba(255,255,255,.22); }
    .panel .body { color: #f5f5f7; }
    .panel .interim { color: #8e8e93; }
    .panel .err { color: #ff6961; }
    @keyframes blink { 0%,100% { opacity: 1; } 50% { opacity: .25; } }
  `;

  const btn = document.createElement("button");
  btn.className = "btn";
  btn.type = "button";
  btn.title = "Kotha — click to dictate (Bengali & English) · drag to move";
  btn.innerHTML =
    '<span class="spinner"></span><svg viewBox="0 0 24 24"><path d="M12 14a3 3 0 0 0 3-3V6a3 3 0 0 0-6 0v5a3 3 0 0 0 3 3zm5-3a5 5 0 0 1-10 0H5a7 7 0 0 0 6 6.92V21h2v-3.08A7 7 0 0 0 19 11h-2z"/></svg>';

  const panel = document.createElement("div");
  panel.className = "panel";

  shadow.appendChild(style);
  shadow.appendChild(btn);
  shadow.appendChild(panel);

  function attachRoot() {
    if (document.documentElement && !document.documentElement.contains(root)) {
      document.documentElement.appendChild(root);
    }
  }
  attachRoot();
  new MutationObserver(attachRoot).observe(document.documentElement, {
    childList: true,
  });

  // ---------------------------------------------------------------- settings

  chrome.storage.local
    .get(["iconPosition", "customPos", "debug"])
    .then((cfg) => {
      if (cfg.iconPosition) iconPosition = cfg.iconPosition;
      if (cfg.customPos) customPos = cfg.customPos;
      debug = !!cfg.debug;
      log("ready", { url: location.href, position: iconPosition });
      forceReposition();
    })
    .catch(() => {});

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "local") return;
    if (changes.iconPosition) {
      iconPosition = changes.iconPosition.newValue || DEFAULT_POSITION;
    }
    if (changes.customPos) {
      customPos = changes.customPos.newValue || null;
    }
    if (changes.iconPosition || changes.customPos) forceReposition();
  });

  // ------------------------------------------------------------ field lookup

  function isEditable(el) {
    if (!el || el.nodeType !== 1) return false;
    if (el.disabled || el.readOnly) return false;
    const tag = el.tagName;
    if (tag === "TEXTAREA") return true;
    if (tag === "INPUT") return EDITABLE_INPUT_TYPES.has((el.type || "text").toLowerCase());
    if (el.isContentEditable) return true;
    return false;
  }

  function fieldUsable(el, rect) {
    if (!el || !el.isConnected) return false;
    if (rect.width === 0 || rect.height === 0) return false;
    // Anchor must actually be within the viewport — otherwise the button would
    // stick to a viewport edge far away from the field it belongs to.
    if (rect.bottom <= 0 || rect.top >= window.innerHeight) return false;
    if (rect.right <= 0 || rect.left >= window.innerWidth) return false;
    const cs = getComputedStyle(el);
    if (cs.visibility === "hidden" || cs.display === "none") return false;
    return true;
  }

  // -------------------------------------------------------------- positioning

  function computeAnchor(rect) {
    const pad = 6;
    switch (iconPosition) {
      case "bottom-right":
        return { top: rect.bottom - BTN_SIZE - pad, left: rect.right - BTN_SIZE - pad };
      case "bottom-left":
        return { top: rect.bottom - BTN_SIZE - pad, left: rect.left + pad };
      case "top-left":
        return { top: rect.top - BTN_SIZE / 2, left: rect.left - BTN_SIZE / 2 };
      case "right-outside":
        return { top: rect.top + rect.height / 2 - BTN_SIZE / 2, left: rect.right + 8 };
      case "top-right":
      default:
        return { top: rect.top - BTN_SIZE / 2, left: rect.right - BTN_SIZE / 2 };
    }
  }

  const clampX = (x) => Math.max(4, Math.min(x, window.innerWidth - BTN_SIZE - 4));
  const clampY = (y) => Math.max(4, Math.min(y, window.innerHeight - BTN_SIZE - 4));

  function placeAt(left, top) {
    btn.style.top = `${top}px`;
    btn.style.left = `${left}px`;
    setVisible(true);

    panel.style.left = `${Math.max(4, Math.min(left, window.innerWidth - PANEL_WIDTH - 8))}px`;
    const below = top + BTN_SIZE + 8;
    const panelHeight = panel.offsetHeight || 60;
    panel.style.top =
      below + panelHeight > window.innerHeight - 8
        ? `${Math.max(4, top - panelHeight - 8)}px`
        : `${below}px`;
  }

  function applyPosition(rect) {
    // Dragged position: the user placed it explicitly, so keep it exactly
    // there for as long as any field is focused — it never chases the field.
    if (iconPosition === "custom" && customPos) {
      if (!activeField || !activeField.isConnected) {
        setVisible(false);
        return;
      }
      placeAt(clampX(customPos.x), clampY(customPos.y));
      return;
    }

    if (!fieldUsable(activeField, rect)) {
      setVisible(false);
      return;
    }

    const anchor = computeAnchor(rect);
    placeAt(clampX(anchor.left), clampY(anchor.top));
  }

  function setVisible(visible) {
    if (visible) {
      if (btn.style.display !== "flex") btn.style.display = "flex";
      if (!btn.classList.contains("show")) {
        requestAnimationFrame(() => btn.classList.add("show"));
      }
      if (dictating && panel.style.display !== "block") {
        panel.style.display = "block";
        requestAnimationFrame(() => panel.classList.add("show"));
      }
    } else {
      btn.classList.remove("show");
      btn.style.display = "none";
      panel.classList.remove("show");
      panel.style.display = "none";
    }
  }

  // Continuously track the field's box. Listening only to scroll/resize misses
  // SPA re-layouts, auto-growing textareas, sidebars opening, zoom, and
  // animated containers — which is what made the icon land in stale spots.
  let trackingFrame = null;
  let lastKey = "";

  function startTracking() {
    if (trackingFrame !== null) return;
    const tick = () => {
      if (!activeField) {
        stopTracking();
        return;
      }
      trackingFrame = requestAnimationFrame(tick);
      const rect = activeField.getBoundingClientRect();
      const key = [
        Math.round(rect.top),
        Math.round(rect.left),
        Math.round(rect.right),
        Math.round(rect.bottom),
        iconPosition,
        window.innerWidth,
        window.innerHeight,
        dictating ? 1 : 0,
      ].join("|");
      if (key === lastKey) return;
      lastKey = key;
      applyPosition(rect);
    };
    trackingFrame = requestAnimationFrame(tick);
  }

  function stopTracking() {
    if (trackingFrame !== null) cancelAnimationFrame(trackingFrame);
    trackingFrame = null;
    lastKey = "";
  }

  function forceReposition() {
    lastKey = "";
    if (activeField) applyPosition(activeField.getBoundingClientRect());
  }

  let warmedUp = false;

  function showField(el) {
    activeField = el;
    lastKey = "";
    applyPosition(el.getBoundingClientRect());
    startTracking();
    if (!warmedUp) {
      warmedUp = true;
      // Spin up the audio worker now so clicking the mic doesn't pay for it.
      sendToBackground({ target: "background", type: "WARM_UP" });
    }
  }

  function detach() {
    activeField = null;
    stopTracking();
    setVisible(false);
  }

  // ----------------------------------------------------------------- events

  document.addEventListener(
    "focusin",
    (e) => {
      if (isEditable(e.target)) {
        showField(e.target);
      } else if (!dictating) {
        detach();
      }
    },
    true
  );

  document.addEventListener(
    "focusout",
    () => {
      if (dictating) return; // keep UI while actively dictating
      setTimeout(() => {
        const focused = document.activeElement;
        if (isEditable(focused)) {
          if (focused !== activeField) showField(focused);
          return;
        }
        detach();
      }, 150);
    },
    true
  );

  // Safety net: some rich-text editors (Notion, ProseMirror-based apps) move
  // focus around internally and can swallow focusin, so re-check on caret moves.
  document.addEventListener("selectionchange", () => {
    if (dictating) return;
    const el = document.activeElement;
    if (isEditable(el) && el !== activeField) showField(el);
  });

  window.addEventListener("resize", forceReposition);

  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && dictating) stopDictation();
  });

  // ------------------------------------------------------- drag to reposition

  let dragState = null;
  let didDrag = false;

  btn.addEventListener("pointerdown", (e) => {
    if (e.button !== 0) return;
    // Also keeps the text field from losing focus when the button is grabbed.
    e.preventDefault();
    didDrag = false;
    const r = btn.getBoundingClientRect();
    dragState = {
      grabX: e.clientX - r.left,
      grabY: e.clientY - r.top,
      startX: e.clientX,
      startY: e.clientY,
    };
    try {
      btn.setPointerCapture(e.pointerId);
    } catch {}
  });

  btn.addEventListener("pointermove", (e) => {
    if (!dragState) return;
    if (
      !didDrag &&
      Math.abs(e.clientX - dragState.startX) < 4 &&
      Math.abs(e.clientY - dragState.startY) < 4
    ) {
      return; // still within click tolerance
    }
    if (!didDrag) {
      didDrag = true;
      btn.classList.add("dragging");
      // Switch to custom mode immediately so the tracking loop stops
      // re-anchoring the button while it is being dragged.
      iconPosition = "custom";
    }
    customPos = {
      x: clampX(e.clientX - dragState.grabX),
      y: clampY(e.clientY - dragState.grabY),
    };
    placeAt(customPos.x, customPos.y);
  });

  function endDrag(e) {
    if (!dragState) return;
    try {
      btn.releasePointerCapture(e.pointerId);
    } catch {}
    dragState = null;
    btn.classList.remove("dragging");
    if (didDrag && customPos) {
      chrome.storage.local
        .set({ iconPosition: "custom", customPos })
        .catch(() => {});
    }
  }

  btn.addEventListener("pointerup", endDrag);
  btn.addEventListener("pointercancel", endDrag);

  btn.addEventListener("click", (e) => {
    if (didDrag) {
      // The pointer sequence was a drag, not a click — don't toggle dictation.
      didDrag = false;
      e.preventDefault();
      e.stopPropagation();
      return;
    }
    if (dictating) stopDictation();
    else startDictation();
  });

  // If a field is already focused when we load, show immediately.
  if (isEditable(document.activeElement)) showField(document.activeElement);

  // --------------------------------------------------------------- messaging

  function messagingFailed(err) {
    const msg = String((err && err.message) || err || "");
    console.warn("[Kotha] messaging error:", msg);
    dictating = false;
    btn.classList.remove("listening", "reconnecting");
    panel.style.display = "block";
    panel.classList.add("show");
    forceReposition();
    renderError(
      /context invalidated|Receiving end does not exist/i.test(msg)
        ? "Extension was reloaded. Refresh this page (F5) to reconnect."
        : "Could not reach the extension: " + msg
    );
  }

  function sendToBackground(payload) {
    // chrome.runtime is gone if the extension was reloaded/updated while this
    // page kept running an older content script.
    if (!chrome.runtime || !chrome.runtime.id) {
      messagingFailed("Extension context invalidated");
      return;
    }
    try {
      const p = chrome.runtime.sendMessage(payload);
      if (p && typeof p.catch === "function") p.catch(messagingFailed);
    } catch (err) {
      messagingFailed(err);
    }
  }

  function startDictation() {
    if (!activeField) return;
    dictating = true;
    interimText = "";
    recentFinalTail = "";
    lastLanguage = "";
    primarySpeaker = null;
    btn.classList.remove("reconnecting");
    btn.classList.add("listening");
    panel.classList.remove("reconnecting");
    panel.style.display = "block";
    requestAnimationFrame(() => panel.classList.add("show"));
    renderConnecting();
    forceReposition();
    sendToBackground({ target: "background", type: "START_DICTATION" });
  }

  function stopDictation() {
    dictating = false;
    btn.classList.remove("listening", "reconnecting");
    panel.classList.remove("show");
    setTimeout(() => (panel.style.display = "none"), 120);
    sendToBackground({ target: "background", type: "STOP_DICTATION" });
  }

  // --------------------------------------------------------------- insertion

  function targetField() {
    if (activeField && activeField.isConnected) return activeField;
    // The SPA may have re-rendered the node we captured on focus.
    const live = document.activeElement;
    return isEditable(live) ? live : null;
  }

  function insertTextAtCursor(text) {
    if (!text) return;
    const el = targetField();
    if (!el) return;

    if (el.tagName === "TEXTAREA" || el.tagName === "INPUT") {
      const start = el.selectionStart ?? el.value.length;
      const end = el.selectionEnd ?? el.value.length;
      const nativeSetter = Object.getOwnPropertyDescriptor(
        window[el.tagName === "TEXTAREA" ? "HTMLTextAreaElement" : "HTMLInputElement"].prototype,
        "value"
      ).set;
      const newValue = el.value.slice(0, start) + text + el.value.slice(end);
      nativeSetter.call(el, newValue);
      const caret = start + text.length;
      el.setSelectionRange(caret, caret);
      el.dispatchEvent(new Event("input", { bubbles: true }));
    } else if (el.isContentEditable) {
      el.focus();
      const sel = window.getSelection();
      if (!sel || sel.rangeCount === 0 || !el.contains(sel.anchorNode)) {
        // No caret inside the field (e.g. focus drifted) — append at the end.
        const range = document.createRange();
        range.selectNodeContents(el);
        range.collapse(false);
        const s = window.getSelection();
        s.removeAllRanges();
        s.addRange(range);
      }
      document.execCommand("insertText", false, text);
      el.dispatchEvent(new Event("input", { bubbles: true }));
    }
  }

  // --------------------------------------------------------------- rendering

  function escapeHtml(s) {
    const d = document.createElement("div");
    d.textContent = s;
    return d.innerHTML;
  }

  // Live language readout, so it's visible whether Soniox is actually
  // switching between Bengali and English rather than locking onto one.
  function languageBadge() {
    if (lastLanguage === "bn") return "বাংলা";
    if (lastLanguage === "en") return "English";
    if (lastLanguage) return lastLanguage.toUpperCase();
    return "বাংলা · EN";
  }

  function renderConnecting() {
    panel.innerHTML =
      '<div class="panel-head"><span class="dot"></span>Connecting…<span class="badge">বাংলা · EN</span></div>' +
      '<div class="body"><span class="interim">Start speaking — your words are captured while it connects.</span></div>';
  }

  function renderListening() {
    panel.innerHTML =
      '<div class="panel-head"><span class="dot"></span>Listening<span class="badge">বাংলা · EN</span></div>' +
      '<div class="meter"><div class="meter-fill"></div></div>' +
      '<div class="body"></div>';
  }

  // Live input meter: shows the mic level and whether the close-talk gate is
  // currently passing audio, so the threshold can be tuned by eye.
  function updateMeter(db, open, gated) {
    const fill = panel.querySelector(".meter-fill");
    if (!fill) return;
    const pct = Math.max(0, Math.min(100, ((db + 60) / 60) * 100));
    fill.style.width = pct + "%";
    fill.className = "meter-fill" + (gated && !open ? " muted" : "");
  }

  function renderTranscript() {
    const body = panel.querySelector(".body");
    if (!body) return;
    body.innerHTML =
      escapeHtml(recentFinalTail) + '<span class="interim">' + escapeHtml(interimText) + "</span>";
    const badge = panel.querySelector(".badge");
    if (badge) badge.textContent = languageBadge();
  }

  function renderReconnecting() {
    panel.classList.add("reconnecting");
    panel.innerHTML =
      '<div class="panel-head"><span class="dot"></span>Reconnecting…<span class="badge">বাংলা · EN</span></div>' +
      '<div class="body">' + escapeHtml(recentFinalTail) + "</div>";
  }

  function renderError(message) {
    panel.classList.remove("reconnecting");
    panel.innerHTML =
      '<div class="panel-head">Kotha</div>' +
      `<div class="err">${escapeHtml(message)}</div>`;
  }

  chrome.runtime.onMessage.addListener((message) => {
    if (!message || message.target !== "content") return;

    if (message.type === "TOKENS") {
      let finalDelta = "";
      let newInterim = "";
      for (const t of message.tokens) {
        // Control markers such as <end> are protocol signals, not speech.
        if (/^<[a-z_]+>$/i.test(t.text)) continue;

        // Speaker lock: the first voice heard in a session is treated as the
        // primary speaker; anyone else nearby who got past the gate is dropped.
        if (message.speakerLock && t.speaker != null) {
          if (primarySpeaker === null) primarySpeaker = t.speaker;
          else if (String(t.speaker) !== String(primarySpeaker)) continue;
        }

        if (t.language) lastLanguage = t.language;
        if (t.is_final) finalDelta += t.text;
        else newInterim += t.text;
      }
      interimText = newInterim;
      if (finalDelta) {
        insertTextAtCursor(finalDelta);
        recentFinalTail = (recentFinalTail + finalDelta).slice(-140);
      }
      if (dictating) {
        btn.classList.remove("reconnecting");
        panel.classList.remove("reconnecting");
        if (!panel.querySelector(".body")) renderListening();
        renderTranscript();
      }
    } else if (message.type === "AUTO_STOPPED") {
      dictating = false;
      btn.classList.remove("listening", "reconnecting");
      panel.style.display = "block";
      panel.classList.add("show");
      forceReposition();
      renderError(message.reason);
      setTimeout(() => {
        if (!dictating) {
          panel.classList.remove("show");
          setTimeout(() => (panel.style.display = "none"), 120);
        }
      }, 4000);
    } else if (message.type === "LEVEL") {
      if (dictating) updateMeter(message.db, message.open, message.gated);
    } else if (message.type === "STATUS" && message.status === "listening") {
      if (dictating) {
        btn.classList.remove("reconnecting");
        panel.classList.remove("reconnecting");
        renderListening();
        renderTranscript();
      }
    } else if (message.type === "STATUS" && message.status === "reconnecting") {
      if (dictating) {
        btn.classList.add("reconnecting");
        renderReconnecting();
      }
    } else if (message.type === "ERROR") {
      dictating = false;
      btn.classList.remove("listening", "reconnecting");
      panel.style.display = "block";
      panel.classList.add("show");
      forceReposition();
      renderError(message.message);
      setTimeout(() => {
        if (!dictating) {
          panel.classList.remove("show");
          setTimeout(() => (panel.style.display = "none"), 120);
        }
      }, 4500);
    } else if (message.type === "STATUS" && message.status === "stopped") {
      dictating = false;
      btn.classList.remove("listening", "reconnecting");
      panel.classList.remove("show", "reconnecting");
      panel.style.display = "none";
      recentFinalTail = "";
    }
  });
})();

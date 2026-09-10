// Visible extension page whose only job is to "prime" microphone permission
// for the extension's origin. Offscreen documents cannot show the permission
// prompt themselves, so this page must be used at least once; afterwards the
// offscreen document can capture audio silently.

const statusEl = document.getElementById("status");
const enableBtn = document.getElementById("enable");
const deniedHelp = document.getElementById("deniedHelp");

deniedHelp.classList.add("hidden");

async function permissionState() {
  try {
    const s = await navigator.permissions.query({ name: "microphone" });
    return s.state;
  } catch {
    return "prompt";
  }
}

function showGranted(autoClose) {
  statusEl.className = "status ok";
  statusEl.textContent = "✓ Microphone enabled. You can start dictating.";
  enableBtn.classList.add("hidden");
  deniedHelp.classList.add("hidden");
  if (autoClose) setTimeout(() => window.close(), 1500);
}

function showDenied(err) {
  statusEl.className = "status bad";
  statusEl.textContent =
    err && err.name === "NotAllowedError"
      ? "Microphone access was blocked."
      : "Could not access the microphone: " + (err ? err.message : "unknown error");
  enableBtn.classList.remove("hidden");
  enableBtn.textContent = "Try again";
  deniedHelp.classList.remove("hidden");
}

async function requestMic() {
  statusEl.className = "status";
  statusEl.textContent = "Waiting for your response…";
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    // We only needed the grant — release the device immediately.
    stream.getTracks().forEach((t) => t.stop());
    showGranted(true);
  } catch (err) {
    showDenied(err);
  }
}

enableBtn.addEventListener("click", requestMic);

(async () => {
  if ((await permissionState()) === "granted") {
    showGranted(true);
  } else {
    // Opened specifically to get this grant — ask straight away.
    requestMic();
  }
})();

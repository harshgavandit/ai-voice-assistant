const chat = document.getElementById("chat");
const micBtn = document.getElementById("micBtn");
const audioFile = document.getElementById("audioFile");
const uploadLabel = document.getElementById("uploadLabel");
const clearBtn = document.getElementById("clearBtn");
const demoBtn = document.getElementById("demoBtn");
const status = document.getElementById("status");
const connection = document.getElementById("connection");
let recorder = null;
let recording = false;
let busy = false;
let starting = false;
let configured = false;
let recordingTimer = null;
let playingAudio = null;
let sessionId = crypto.randomUUID();
let maxAudioBytes = 24 * 1024 * 1024;

function setStatus(text) { status.textContent = text; }
function updateControls() {
  micBtn.disabled = busy || starting || !configured;
  audioFile.disabled = busy || starting || recording || !configured;
  uploadLabel.classList.toggle("disabled", audioFile.disabled);
  clearBtn.disabled = busy || starting || recording;
  demoBtn.disabled = busy || starting || recording || !configured;
  micBtn.classList.toggle("recording", recording);
  micBtn.setAttribute("aria-pressed", String(recording));
  micBtn.textContent = recording ? "Stop & send" : busy ? "Processing…" : starting ? "Opening microphone…" : "Start recording";
}
function addMessage(text, role) {
  document.getElementById("welcome")?.remove();
  const bubble = document.createElement("div");
  bubble.className = `bubble ${role}`;
  bubble.textContent = text;
  chat.appendChild(bubble);
  bubble.scrollIntoView({ behavior: "smooth", block: "nearest" });
  return bubble;
}
function pauseAudio() {
  if (playingAudio) playingAudio.pause();
  playingAudio = null;
}
async function sendAudio(blob, filename) {
  if (busy) return;
  if (!blob.size) { setStatus("The recording is empty. Please try again."); return; }
  if (blob.size > maxAudioBytes) { setStatus(`Choose an audio file smaller than ${Math.floor(maxAudioBytes / (1024 * 1024))} MB.`); return; }
  busy = true;
  pauseAudio();
  updateControls();
  setStatus("Transcribing, creating your reply, and generating speech…");
  const userBubble = addMessage("Processing your recording…", "user");
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 200000);
  try {
    const form = new FormData();
    form.append("file", blob, filename);
    form.append("session_id", sessionId);
    const response = await fetch("/assistant", { method: "POST", body: form, signal: controller.signal });
    const data = await response.json().catch(() => null);
    if (!response.ok) throw new Error(typeof data?.detail === "string" ? data.detail : response.status === 413 ? `Choose an audio file smaller than ${Math.floor(maxAudioBytes / (1024 * 1024))} MB.` : "The assistant could not process this recording. Please try again.");
    if (!data?.transcript || !data?.response || !data?.audio_base64) throw new Error("The server returned an incomplete reply.");
    userBubble.textContent = data.transcript;
    const replyBubble = addMessage(data.response, "assistant");
    const audio = document.createElement("audio");
    audio.controls = true;
    audio.preload = "auto";
    audio.setAttribute("aria-label", "Play assistant reply");
    audio.src = `data:${data.audio_mime_type || "audio/mpeg"};base64,${data.audio_base64}`;
    replyBubble.appendChild(audio);
    audio.addEventListener("play", () => { if (playingAudio !== audio) pauseAudio(); playingAudio = audio; });
    playingAudio = audio;
    try {
      await audio.play();
      setStatus("Reply ready. You can record a follow-up.");
    } catch {
      const note = document.createElement("span");
      note.className = "playback-note";
      note.textContent = "Press Play to hear your reply.";
      replyBubble.appendChild(note);
      setStatus("Reply ready. Press Play to hear it.");
    }
  } catch (error) {
    userBubble.textContent = "Recording could not be processed.";
    const message = error.name === "AbortError" ? "The request took too long. Please try again." : error.message;
    addMessage(message, "assistant error");
    setStatus("Please check the error above and try again.");
  } finally {
    clearTimeout(timeout);
    busy = false;
    updateControls();
  }
}

micBtn.addEventListener("click", async () => {
  if (busy || starting || !configured) return;
  if (recording) { stopRecording(); return; }
  if (!navigator.mediaDevices?.getUserMedia || !window.MediaRecorder) {
    setStatus("Microphone recording requires a supported browser on localhost or HTTPS. You can upload audio instead.");
    return;
  }
  starting = true;
  updateControls();
  pauseAudio();
  let stream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    const mimeType = ["audio/webm;codecs=opus", "audio/webm", "audio/mp4"].find(type => MediaRecorder.isTypeSupported(type));
    recorder = mimeType ? new MediaRecorder(stream, { mimeType }) : new MediaRecorder(stream);
    const currentRecorder = recorder;
    const chunks = [];
    let recorderFailed = false;
    currentRecorder.ondataavailable = event => { if (event.data.size) chunks.push(event.data); };
    currentRecorder.onerror = () => {
      recorderFailed = true;
      if (currentRecorder.state !== "inactive") currentRecorder.stop();
      stream.getTracks().forEach(track => track.stop());
      recording = false;
      clearTimeout(recordingTimer);
      updateControls();
      setStatus("Recording failed. Please try again or upload audio.");
    };
    currentRecorder.onstop = () => {
      clearTimeout(recordingTimer);
      stream.getTracks().forEach(track => track.stop());
      recording = false;
      recorder = null;
      updateControls();
      if (recorderFailed) return;
      const type = currentRecorder.mimeType || chunks[0]?.type || "audio/webm";
      const extension = type.includes("mp4") ? "m4a" : type.includes("ogg") ? "ogg" : "webm";
      void sendAudio(new Blob(chunks, { type }), `speech.${extension}`);
    };
    currentRecorder.start();
    recording = true;
    setStatus("Recording… tap Stop & send when finished. Maximum 60 seconds.");
    recordingTimer = setTimeout(stopRecording, 60000);
  } catch (error) {
    stream?.getTracks().forEach(track => track.stop());
    recording = false;
    recorder = null;
    const messages = {
      NotAllowedError: "Microphone permission was denied. Allow it in your browser or upload an audio file.",
      NotFoundError: "No microphone was found. Connect a microphone or upload audio.",
      NotReadableError: "The microphone is unavailable or in use. Close other recording apps and try again.",
    };
    setStatus(messages[error.name] || "Unable to start the microphone. Try uploading an audio recording.");
  } finally {
    starting = false;
    updateControls();
  }
});
function stopRecording() {
  if (recorder && recorder.state !== "inactive") {
    recording = false;
    busy = true; // Prevent a second recording while the final chunk arrives.
    updateControls();
    const currentRecorder = recorder;
    const previousStop = currentRecorder.onstop;
    currentRecorder.onstop = event => { busy = false; previousStop(event); };
    currentRecorder.stop();
  }
}
audioFile.addEventListener("change", () => {
  const file = audioFile.files[0];
  if (file) void sendAudio(file, file.name);
  audioFile.value = "";
});
demoBtn.addEventListener("click", async () => {
  if (busy || recording || starting || !configured) return;
  starting = true;
  updateControls();
  setStatus("Loading a synthetic demo recording…");
  try {
    const response = await fetch("/demo.wav");
    if (!response.ok) throw new Error("Unable to load the demo recording.");
    const blob = await response.blob();
    starting = false;
    await sendAudio(blob, "demo.wav");
  } catch (error) {
    setStatus(error.message);
  } finally {
    starting = false;
    updateControls();
  }
});
clearBtn.addEventListener("click", () => {
  if (busy || recording || starting) return;
  pauseAudio();
  chat.replaceChildren();
  sessionId = crypto.randomUUID();
  setStatus("New conversation started. Ready when you are.");
});
window.addEventListener("pagehide", () => {
  if (recorder) {
    recorder.onstop = null;
    if (recorder.state !== "inactive") recorder.stop();
    recorder.stream.getTracks().forEach(track => track.stop());
  }
  clearTimeout(recordingTimer);
  pauseAudio();
});
async function checkHealth() {
  try {
    const response = await fetch("/health");
    if (!response.ok) throw new Error("Health check failed");
    const data = await response.json();
    configured = Boolean(data.api_key_configured);
    if (Number.isSafeInteger(data.max_audio_bytes) && data.max_audio_bytes > 0) maxAudioBytes = data.max_audio_bytes;
    connection.textContent = configured ? `Ready · ${data.model}` : "OpenAI API key is missing from the server configuration.";
    if (!configured) setStatus("Configure the API key in .env and restart the server.");
  } catch {
    connection.textContent = "Cannot connect to the assistant server.";
    setStatus("Open this page through the running FastAPI server, then reload.");
  }
  updateControls();
}
updateControls();
void checkHealth();

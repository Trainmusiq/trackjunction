// Hilo principal — orquesta la UI, nunca hace cómputo pesado (todo vive en
// Workers, ver workers/separate.worker.mjs y CLAUDE.md sobre el gotcha de
// throttling en pestañas en segundo plano).

import { encodeWav } from "./engine/wav.mjs?v=0.11.0";

// ---- Bandera de habilitación (ver docs/especificacion.md §11.9-§11.11) ----
// "Canción completa" (4 stems): ratificada de oído por el fundador (§11.11,
// caso hostil "04 - Puente" con batería activa en las costuras) — imperceptible
// en escucha dirigida, aunque la diferencia medida (~-50dB) no llegue al
// umbral de -80dB que sí cumple karaoke matemáticamente. Kill-switch: en
// false vuelve a ocultar el modo sin tocar el resto del código.
const FULL_SONG_ENABLED = true;
const KARAOKE_ENABLED = true;
const MAX_FRAGMENT_SECS = 34;
const TARGET_SAMPLE_RATE = 44100;
const WEIGHTS_URL = new URL("vendor/demucs-weights/ggml-model-htdemucs-4s-f16.bin", location.href).href;

// ---- i18n ----
const STRINGS = {
  es: {
    tagline: "separación de stems, con su calidad medida",
    dropBig: "Suelta una canción aquí, o haz clic para elegir",
    chooseMode: "Elige cómo separarla",
    selTooLong: "máximo 34s — bit-perfecto solo hasta ahí",
    useFragment: "Separar esta sección",
    results: "Resultado —",
    playAll: "▶ reproducir",
    loop: "loop: off",
    demandBtn: "Canción completa bit-perfecta en segundos — próximamente (servidor)",
    demandThanks: "Va a llegar con el tier servidor. Tu interés queda contado en este navegador — gracias.",
    demandAlready: "Ya contamos tu interés en este navegador — gracias de nuevo.",
    newsletterTitle: "Te avisamos cuando esté cerca la próxima estación.",
    newsletterBtn: "Avísame",
    newsletterNote: "Se abrirá Buttondown y te llegará un correo — confirma ahí tu inscripción. Sin spam; puedes borrarte cuando quieras.",
    modeKaraokeTitle: "Karaoke — quitar voz (canción completa)",
    modeKaraokeQuality: "Certificado — diferencia medida −82 a −87dB vs proceso de referencia",
    modeKaraokeWhy: "Mezcla original menos el stem de voz — hereda la calidad del stem de voz, que ya pasa el umbral.",
    modeFullTitle: "Canción completa (4 stems)",
    modeFullQuality: "Calidad alta — diferencia medida ~−50dB vs proceso de referencia, ratificada inaudible en escucha dirigida",
    modeFullWhy: "Troceo con descarte de bordes + Workers en paralelo — verificado con material hostil (batería activa en las costuras). Ver docs/especificacion.md §11.11.",
    modeStudioTitle: "Sección de estudio (eliges hasta 34s)",
    modeStudioQuality: "Bit-perfecto garantizado",
    modeStudioWhy: "La parte que estás practicando — un solo, un coro, un puente — aislada sin trocear. Hoy con 4 stems; en v2.1 suma guitarra y piano para aislar solos con más precisión.",
    stageDecoding: "decodificando audio",
    stageResample: "ajustando frecuencia de muestreo",
    footerKofi: "Suscríbete para más opciones y mayor velocidad. Y si con la versión gratuita te basta, siempre puedes invitarnos un café ☕.",
  },
  en: {
    tagline: "stem separation, with its quality measured",
    dropBig: "Drop a song here, or click to choose",
    chooseMode: "Choose how to separate it",
    selTooLong: "34s max — bit-perfect only up to there",
    useFragment: "Separate this section",
    results: "Result —",
    playAll: "▶ play",
    loop: "loop: off",
    demandBtn: "Full song bit-perfect in seconds — coming soon (server)",
    demandThanks: "It'll arrive with the server tier. Your interest is counted on this browser — thank you.",
    demandAlready: "We already counted your interest on this browser — thanks again.",
    newsletterTitle: "We'll let you know when the next station is near.",
    newsletterBtn: "Notify me",
    newsletterNote: "Buttondown will open and you'll get an email — confirm your signup there. No spam; unsubscribe anytime.",
    modeKaraokeTitle: "Karaoke — remove vocals (full song)",
    modeKaraokeQuality: "Certified — measured difference −82 to −87dB vs reference process",
    modeKaraokeWhy: "Original mix minus the vocal stem — inherits the vocal stem's quality, which already passes the bar.",
    modeFullTitle: "Full song (4 stems)",
    modeFullQuality: "High quality — measured difference ~−50dB vs reference process, ratified inaudible under directed listening",
    modeFullWhy: "Edge-discard chunking + parallel Workers — verified with hostile material (drums active at the seams). See docs/especificacion.md §11.11.",
    modeStudioTitle: "Studio section (choose up to 34s)",
    modeStudioQuality: "Bit-perfect guaranteed",
    modeStudioWhy: "The part you're practicing — a solo, a chorus, a bridge — isolated with no chunking. 4 stems today; v2.1 adds guitar and piano to isolate solos with more precision.",
    stageDecoding: "decoding audio",
    stageResample: "resampling",
    footerKofi: "Subscribe for more options and more speed. And if the free version is already enough for you, you can always buy us a coffee ☕.",
  },
};
// Lista de idiomas disponibles en el selector — agregar acá + una entrada en
// STRINGS es lo único que hace falta para sumar un idioma en v2.0.1 (hasta 10).
const LANGUAGES = [
  { code: "es", label: "Español" },
  { code: "en", label: "English" },
];
let lang = "es";
function t(key) { return STRINGS[lang][key] || key; }
function applyI18n() {
  document.querySelectorAll("[data-i18n]").forEach((el) => {
    const key = el.getAttribute("data-i18n");
    el.textContent = t(key);
  });
  renderModes();
}

// ---- Estado ----
let audioBuffer = null; // AudioBuffer decodificado y resampleado a 44100
let channelData = null; // [Float32Array L, Float32Array R]
let originalBaseName = "trackjunction"; // nombre del archivo cargado, sin extensión, para nombrar descargas
let selection = { startSec: 0, endSec: 0 };
let orchestratorWorker = null;
let playCtx = null;
let playNodes = []; // {name, source, gain}
let currentResult = null; // { stems, sampleRate, qualityKey }
let loopOn = false;

// ---- Elementos ----
const $ = (id) => document.getElementById(id);
const dropEl = $("drop"), fileInput = $("fileInput");
const modeCard = $("modeCard"), modesEl = $("modes");
const waveformWrap = $("waveformWrap"), canvas = $("waveform"), selInfo = $("selInfo"), selWarn = $("selWarn");
const useFragmentBtn = $("useFragmentBtn");
const progressEl = $("progress"), progressPct = $("progressPct"), progressBar = $("progressBar");
const progressStage = $("progressStage"), progressResource = $("progressResource");
const resultsCard = $("resultsCard"), stemRowsEl = $("stemRows"), resultQualityEl = $("resultQuality");
const demandCard = $("demandCard"), demandBtn = $("demandBtn"), demandNote = $("demandNote"), demandCount = $("demandCount");

// ---- Carga de archivo ----
dropEl.addEventListener("click", () => fileInput.click());
dropEl.addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === " ") fileInput.click(); });
dropEl.addEventListener("dragover", (e) => { e.preventDefault(); dropEl.classList.add("dragover"); });
dropEl.addEventListener("dragleave", () => dropEl.classList.remove("dragover"));
dropEl.addEventListener("drop", (e) => {
  e.preventDefault();
  dropEl.classList.remove("dragover");
  const file = e.dataTransfer.files[0];
  if (file) loadFile(file);
});
fileInput.addEventListener("change", () => {
  if (fileInput.files[0]) loadFile(fileInput.files[0]);
});
// Drag & drop global (patrón centrail): soltar en cualquier parte de la página
window.addEventListener("dragover", (e) => e.preventDefault());
window.addEventListener("drop", (e) => {
  if (e.target === dropEl || dropEl.contains(e.target)) return;
  e.preventDefault();
  const file = e.dataTransfer.files[0];
  if (file) loadFile(file);
});

async function loadFile(file) {
  originalBaseName = file.name.replace(/\.[^.]+$/, "").replace(/[^a-zA-Z0-9_-]+/g, "_") || "trackjunction";
  showProgress(0.05, t("stageDecoding"), "");
  const arrayBuf = await file.arrayBuffer();
  const ctx = new (window.AudioContext || window.webkitAudioContext)();
  let decoded;
  try {
    decoded = await ctx.decodeAudioData(arrayBuf);
  } catch (err) {
    hideProgress();
    alert("No se pudo decodificar el archivo (" + err.message + ")");
    return;
  }

  if (decoded.sampleRate !== TARGET_SAMPLE_RATE) {
    showProgress(0.5, t("stageResample"), "");
    const offline = new OfflineAudioContext(
      decoded.numberOfChannels, Math.ceil(decoded.duration * TARGET_SAMPLE_RATE), TARGET_SAMPLE_RATE
    );
    const src = offline.createBufferSource();
    src.buffer = decoded;
    src.connect(offline.destination);
    src.start();
    decoded = await offline.startRendering();
  }
  ctx.close();

  audioBuffer = decoded;
  const left = decoded.getChannelData(0);
  const right = decoded.numberOfChannels > 1 ? decoded.getChannelData(1) : decoded.getChannelData(0);
  channelData = [Float32Array.from(left), Float32Array.from(right)];

  hideProgress();
  drawWaveform();
  modeCard.classList.remove("hidden");
  selection = { startSec: 0, endSec: Math.min(MAX_FRAGMENT_SECS, decoded.duration) };
  updateSelectionInfo();
  renderModes();
}

// ---- Forma de onda + selección (modo Fragmento) ----
function drawWaveform() {
  const ctxc = canvas.getContext("2d");
  const w = canvas.width, h = canvas.height;
  ctxc.clearRect(0, 0, w, h);
  ctxc.fillStyle = "#24272f";
  ctxc.fillRect(0, 0, w, h);
  const data = channelData[0];
  const step = Math.ceil(data.length / w);
  ctxc.strokeStyle = "#9a968c";
  ctxc.beginPath();
  for (let x = 0; x < w; x++) {
    let min = 1, max = -1;
    const start = x * step;
    for (let i = start; i < Math.min(start + step, data.length); i++) {
      if (data[i] < min) min = data[i];
      if (data[i] > max) max = data[i];
    }
    const y1 = (1 - (max + 1) / 2) * h;
    const y2 = (1 - (min + 1) / 2) * h;
    ctxc.moveTo(x, y1);
    ctxc.lineTo(x, y2);
  }
  ctxc.stroke();
}

function drawSelectionOverlay() {
  drawWaveform();
  const ctxc = canvas.getContext("2d");
  const w = canvas.width, h = canvas.height;
  const dur = audioBuffer.duration;
  const x1 = (selection.startSec / dur) * w;
  const x2 = (selection.endSec / dur) * w;
  ctxc.fillStyle = "rgba(95,212,196,0.18)";
  ctxc.fillRect(x1, 0, x2 - x1, h);
  ctxc.strokeStyle = "#5fd4c4";
  ctxc.strokeRect(x1, 0, x2 - x1, h);
}

let dragStartX = null;
canvas.addEventListener("mousedown", (e) => {
  if (!audioBuffer) return;
  dragStartX = e.offsetX;
});
canvas.addEventListener("mousemove", (e) => {
  if (dragStartX === null || !audioBuffer) return;
  // e.offsetX vive en espacio CSS (ancho renderizado, ver getBoundingClientRect) —
  // canvas.width es el búfer interno de dibujo (1200, fijo por atributo HTML), NO
  // el ancho visible. Dividir por canvas.width acá comprimía la selección: en un
  // canvas renderizado más angosto que 1200px, arrastrar sobre TODO el ancho visible
  // nunca llegaba al final real de la canción (bug encontrado en producción,
  // reportado como "Sección de estudio rota" — no se podía seleccionar el tramo
  // final de un tema).
  const w = canvas.getBoundingClientRect().width;
  const dur = audioBuffer.duration;
  const x1 = Math.min(dragStartX, e.offsetX), x2 = Math.max(dragStartX, e.offsetX);
  let startSec = (x1 / w) * dur;
  let endSec = (x2 / w) * dur;
  if (endSec - startSec > MAX_FRAGMENT_SECS) endSec = startSec + MAX_FRAGMENT_SECS;
  selection = { startSec, endSec };
  updateSelectionInfo();
  drawSelectionOverlay();
});
window.addEventListener("mouseup", () => { dragStartX = null; });

function updateSelectionInfo() {
  const len = selection.endSec - selection.startSec;
  selInfo.textContent = `${selection.startSec.toFixed(1)}s – ${selection.endSec.toFixed(1)}s (${len.toFixed(1)}s)`;
  selWarn.classList.toggle("hidden", len < MAX_FRAGMENT_SECS - 0.05);
}

// ---- Modos ----
function renderModes() {
  if (!channelData) return;
  const durationSecs = channelData[0].length / TARGET_SAMPLE_RATE;
  modesEl.innerHTML = "";

  modesEl.appendChild(modeButton({
    title: t("modeKaraokeTitle"), quality: t("modeKaraokeQuality"), why: t("modeKaraokeWhy"),
    enabled: KARAOKE_ENABLED, onClick: () => selectMode("karaoke"),
  }));

  modesEl.appendChild(modeButton({
    title: t("modeFullTitle"), quality: t("modeFullQuality"), why: t("modeFullWhy"),
    enabled: FULL_SONG_ENABLED, onClick: () => selectMode("full"),
  }));

  modesEl.appendChild(modeButton({
    title: t("modeStudioTitle"), quality: t("modeStudioQuality"), why: t("modeStudioWhy"),
    enabled: true, onClick: () => selectMode("studio"),
  }));

  waveformWrap.classList.remove("hidden");
  drawSelectionOverlay();
  void durationSecs;
}

function modeButton({ title, quality, why, enabled, onClick }) {
  const btn = document.createElement("button");
  btn.className = "mode-btn";
  btn.disabled = !enabled;
  btn.innerHTML = `<div><div class="title">${title}</div><div class="quality">${quality}</div><div class="why">${why}</div></div><div class="arrow">→</div>`;
  btn.addEventListener("click", onClick);
  return btn;
}

function selectMode(mode) {
  if (mode === "studio") {
    waveformWrap.classList.remove("hidden");
    return; // separar se dispara desde useFragmentBtn (ver listener abajo), no acá
  }
  runSeparation(mode);
}
useFragmentBtn.addEventListener("click", () => { runSeparation("studio"); });

// ---- Separación ----
function getOrchestrator() {
  if (!orchestratorWorker) {
    orchestratorWorker = new Worker(new URL("workers/separate.worker.mjs", import.meta.url), { type: "module" });
  }
  return orchestratorWorker;
}

function runSeparation(mode) {
  let left = channelData[0], right = channelData[1];
  if (mode === "studio") {
    const startN = Math.round(selection.startSec * TARGET_SAMPLE_RATE);
    const endN = Math.round(selection.endSec * TARGET_SAMPLE_RATE);
    left = left.slice(startN, endN);
    right = right.slice(startN, endN);
  }

  const leftBuf = left.buffer.slice(left.byteOffset, left.byteOffset + left.byteLength);
  const rightBuf = right.buffer.slice(right.byteOffset, right.byteOffset + right.byteLength);

  showProgress(0.01, "iniciando", "");
  const w = getOrchestrator();
  w.onmessage = (ev) => {
    const msg = ev.data;
    if (msg.type === "progress") {
      showProgress(msg.pct, msg.stage, msg.resourceMessage || msg.detail || "");
    } else if (msg.type === "done") {
      hideProgress();
      currentResult = {
        stems: Object.fromEntries(
          Object.entries(msg.stems).map(([name, [l, r]]) => [name, [new Float32Array(l), new Float32Array(r)]])
        ),
        sampleRate: msg.sampleRate,
        qualityKey: mode === "studio" ? "modeStudioQuality" : mode === "karaoke" ? "modeKaraokeQuality" : "modeFullQuality",
      };
      renderResults();
    } else if (msg.type === "error") {
      hideProgress();
      alert("Error separando: " + msg.message);
    }
  };
  w.postMessage(
    {
      mode, left: leftBuf, right: rightBuf, sampleRate: TARGET_SAMPLE_RATE, weightsUrl: WEIGHTS_URL,
      hardwareConcurrency: navigator.hardwareConcurrency,
    },
    [leftBuf, rightBuf]
  );
}

function showProgress(pct, stage, resource) {
  progressEl.classList.add("on");
  progressPct.textContent = Math.round(pct * 100) + "%";
  progressBar.style.width = Math.round(pct * 100) + "%";
  progressStage.textContent = stage;
  progressResource.textContent = resource || "";
}
function hideProgress() { progressEl.classList.remove("on"); }

// ---- Resultado: mezclador + descarga ----
let muted = {};
let soloName = null;

function applyMixerGains() {
  for (const node of playNodes) {
    const isMuted = soloName ? node.name !== soloName : muted[node.name];
    node.gain.gain.value = isMuted ? 0 : 1;
  }
}

function renderResults() {
  resultsCard.classList.remove("hidden");
  resultQualityEl.textContent = t(currentResult.qualityKey);
  stemRowsEl.innerHTML = "";
  muted = {};
  soloName = null;

  for (const name of Object.keys(currentResult.stems)) {
    muted[name] = false;
    const row = document.createElement("div");
    row.className = "stem-row";
    row.innerHTML = `
      <div class="stem-name">${name}</div>
      <button class="stem-btn" data-act="mute" data-name="${name}">mute</button>
      <button class="stem-btn" data-act="solo" data-name="${name}">solo</button>
      <a class="dl-link" data-act="wav" data-name="${name}">WAV</a>
      <a class="dl-link" data-act="flac" data-name="${name}">FLAC</a>
    `;
    stemRowsEl.appendChild(row);
  }

  stemRowsEl.querySelectorAll("button[data-act=mute]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const name = btn.dataset.name;
      muted[name] = !muted[name];
      btn.classList.toggle("active-mute", muted[name]);
      applyMixerGains();
    });
  });
  stemRowsEl.querySelectorAll("button[data-act=solo]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const name = btn.dataset.name;
      soloName = soloName === name ? null : name;
      stemRowsEl.querySelectorAll("button[data-act=solo]").forEach((b) => b.classList.toggle("active-solo", b.dataset.name === soloName));
      applyMixerGains();
    });
  });
  stemRowsEl.querySelectorAll("a[data-act=wav]").forEach((a) => {
    a.addEventListener("click", (e) => { e.preventDefault(); downloadStem(a.dataset.name, "wav"); });
    a.href = "#";
  });
  stemRowsEl.querySelectorAll("a[data-act=flac]").forEach((a) => {
    a.addEventListener("click", (e) => { e.preventDefault(); downloadStem(a.dataset.name, "flac"); });
    a.href = "#";
  });

  setupPlayback();
}

function setupPlayback() {
  stopPlayback();
  playCtx = new (window.AudioContext || window.webkitAudioContext)();
  playNodes = [];
  for (const [name, [l, r]] of Object.entries(currentResult.stems)) {
    const buf = playCtx.createBuffer(2, l.length, currentResult.sampleRate);
    buf.copyToChannel(l, 0);
    buf.copyToChannel(r, 1);
    const source = playCtx.createBufferSource();
    source.buffer = buf;
    source.loop = loopOn;
    const gain = playCtx.createGain();
    source.connect(gain).connect(playCtx.destination);
    playNodes.push({ name, source, gain, buf });
  }
}

function stopPlayback() {
  for (const node of playNodes) { try { node.source.stop(); } catch {} }
  playNodes = [];
  if (playCtx) { playCtx.close(); playCtx = null; }
}

$("playAllBtn").addEventListener("click", () => {
  if (!currentResult) return;
  setupPlayback();
  applyMixerGains();
  const t0 = playCtx.currentTime + 0.05;
  for (const node of playNodes) node.source.start(t0);
});
$("loopBtn").addEventListener("click", (e) => {
  loopOn = !loopOn;
  e.target.textContent = loopOn ? "loop: on" : "loop: off";
});

function downloadStem(name, format) {
  const [l, r] = currentResult.stems[name];
  let bytes, mime, ext;
  if (format === "wav") {
    bytes = encodeWav({ channelData: [l, r], sampleRate: currentResult.sampleRate, bitDepth: 16 });
    mime = "audio/wav"; ext = "wav";
  } else {
    // FLAC: import perezoso, encoder pesado (WASM) — solo se carga si se pide.
    import("./engine/flac-encode.mjs?v=0.11.0").then(async ({ encodeFlac }) => {
      const flacBytes = await encodeFlac({ channelData: [l, r], sampleRate: currentResult.sampleRate, bitDepth: 16 });
      triggerDownload(flacBytes, `${originalBaseName}_${name}.flac`, "audio/flac");
    });
    return;
  }
  triggerDownload(bytes, `${originalBaseName}_${name}.${ext}`, mime);
}

function triggerDownload(bytes, filename, mime) {
  const blob = new Blob([bytes], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url; a.download = filename;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
}

// ---- Instrumento de demanda (contador local, limitación declarada) ----
// No hay servidor (regla dura #5: sin CDN externos, todo auto-hosteado) —
// esto cuenta "¿ya clickeaste en ESTE navegador?", no un total global. Un
// contador global real necesitaría un endpoint propio (candidato natural
// para un Cloudflare Worker mínimo cuando se abra la Fase A del servidor,
// ver docs/especificacion.md §11.10 y roadmap del ecosistema).
demandCard.classList.remove("hidden");
demandBtn.addEventListener("click", () => {
  const already = localStorage.getItem("tj_demand_clicked") === "1";
  localStorage.setItem("tj_demand_clicked", "1");
  demandNote.textContent = already ? t("demandAlready") : t("demandThanks");
});

// ---- Newsletter (Buttondown: buttondown.com/trainmusiq, doble opt-in, sin rastreo) ----
// El form es un <form action=... target="_blank"> nativo (ver index.html), sin JS:
// Buttondown exige un desafío Turnstile en este endpoint, que solo puede resolver
// un humano en una carga de página real de buttondown.com — un fetch() en segundo
// plano (con mode:"no-cors", que además no deja leer la respuesta) nunca lo pasa.

// ---- Idioma ----
const langSelect = document.getElementById("langSelect");
for (const { code, label } of LANGUAGES) {
  const opt = document.createElement("option");
  opt.value = code; opt.textContent = label;
  langSelect.appendChild(opt);
}
langSelect.value = lang;
langSelect.addEventListener("change", () => {
  lang = langSelect.value;
  applyI18n();
});

applyI18n();

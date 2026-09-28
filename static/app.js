/* What Happened Here? 2.0 — front end
   ------------------------------------------------------------------
   No framework: upload/record -> POST /api/analyse -> read the SSE
   stream of 4 stages -> render cards, spectrogram and a sortable table. */

const $ = (id) => document.getElementById(id);

let CONFIG = null;          // engine defaults, fetched from the server
let PENDING = null;         // File/Blob waiting to be analysed
let LAST = null;            // last result payload
let ROWS = [];              // rows currently in the table
let SORT = { key: "i", dir: 1 };
let RECORDING = null;       // state of an in-progress recording

/* ------------------------------------------------------------------ */
/* boot                                                                */
/* ------------------------------------------------------------------ */
init();

async function init() {
  try {
    CONFIG = await (await fetch("/api/config")).json();
    resetParams();
  } catch {
    CONFIG = { min_duration: 0.1, merge_gap: 0.4, on_margin: 6, off_margin: 4,
               attack: 0.1, release: 0.1, duration: 0 };
  }
  wireUpload();
  wireRecorder();
  wireTable();
  wireButtons();
}

function resetParams() {
  for (const k of ["min_duration", "merge_gap", "on_margin", "off_margin",
                   "attack", "release", "duration"]) {
    if ($(k)) $(k).value = CONFIG[k];
  }
  if ($("skip_model")) $("skip_model").checked = false;
}

function wireButtons() {
  $("resetParams").onclick = resetParams;
  $("analyseBtn").onclick = () => PENDING && analyse(PENDING);
  $("againBtn").onclick = () => {
    $("results").hidden = true;
    window.scrollTo({ top: 0, behavior: "smooth" });
  };
}

/* ------------------------------------------------------------------ */
/* upload / drag & drop                                                */
/* ------------------------------------------------------------------ */
function wireUpload() {
  const dz = $("dropzone"), input = $("fileInput");

  $("browseBtn").onclick = (e) => { e.stopPropagation(); input.click(); };
  dz.onclick = () => input.click();
  dz.onkeydown = (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); input.click(); } };
  input.onchange = () => input.files[0] && takeFile(input.files[0]);

  ["dragenter", "dragover"].forEach((ev) =>
    dz.addEventListener(ev, (e) => { e.preventDefault(); dz.classList.add("drag"); }));
  ["dragleave", "drop"].forEach((ev) =>
    dz.addEventListener(ev, (e) => { e.preventDefault(); dz.classList.remove("drag"); }));
  dz.addEventListener("drop", (e) => {
    const f = e.dataTransfer.files && e.dataTransfer.files[0];
    if (f) takeFile(f);
  });
}

function takeFile(file) {
  PENDING = file;
  $("analyseBtn").hidden = false;
  $("pending").hidden = false;
  $("pending").textContent =
    `Ready: ${file.name} · ${(file.size / 1048576).toFixed(1)} MB — then press “Analyse this recording”.`;
  $("error").hidden = true;
}

/* ------------------------------------------------------------------ */
/* in-browser recorder (same 2–3 minute brief as record.py)            */
/* ------------------------------------------------------------------ */
function wireRecorder() {
  $("micBtn").onclick = (e) => { e.stopPropagation(); startRecording(); };
  $("recStop").onclick = stopRecording;
}

async function startRecording() {
  let stream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: false, autoGainControl: false },
    });
  } catch (err) {
    alert("Microphone access was refused — allow it in the browser, or drop a file instead.\n" + err);
    return;
  }

  const ctx = new (window.AudioContext || window.webkitAudioContext)();
  const sr = ctx.sampleRate;
  const src = ctx.createMediaStreamSource(stream);
  const proc = ctx.createScriptProcessor(4096, 1, 1);
  const mute = ctx.createGain();
  mute.gain.value = 0;
  src.connect(proc);
  proc.connect(mute);
  mute.connect(ctx.destination);

  const state = {
    ctx, stream, proc, sr, chunks: [], samples: 0, peak: 0, clipped: false,
    t0: 0, armed: false, stop: false,
  };
  RECORDING = state;

  proc.onaudioprocess = (e) => {
    if (!state.armed || state.stop) return;
    const d = new Float32Array(e.inputBuffer.getChannelData(0));
    const room = Math.max(0, Math.round(180 * sr) - state.samples);   // hard cap: 3 min
    const n = Math.min(d.length, room);
    if (n > 0) {
      state.chunks.push(d.subarray(0, n));
      state.samples += n;
      const p = Math.max(...Array.from(d.subarray(0, n), Math.abs));
      if (p > state.peak) state.peak = p;
      if (p >= 0.999) state.clipped = true;
    }
    if (state.samples >= Math.round(180 * sr)) stopRecording();
  };

  $("recorder").hidden = false;
  $("micBtn").disabled = true;
  $("recHint").textContent = "Speak, move things, close a door — make it sound like a real room.";

  // 3-second countdown, then arm the capture (the task wants 2–3 minutes)
  for (let n = 3; n > 0; n--) {
    $("recStatus").textContent = `Starting in ${n}…`;
    await new Promise((r) => setTimeout(r, 1000));
    if (RECORDING !== state) return;             // user bailed out
  }
  state.armed = true;
  state.t0 = performance.now();
  $("recStatus").textContent = "Recording";

  const tick = setInterval(() => {
    if (!state.armed || state.stop) return clearInterval(tick);
    const secs = state.samples / sr;
    const db = 20 * Math.log10(state.peak + 1e-9);
    $("meterFill").style.width = Math.min(100, Math.max(0, (db + 60) * (100 / 60))) + "%";
    $("recTime").textContent = secs.toFixed(1) + " / 180 s";
    $("recPeak").textContent = state.clipped ? "CLIPPING — move away!" : `peak ${db.toFixed(1)} dB`;
    $("recPeak").classList.toggle("clip", state.clipped);
    if (secs >= 180) { clearInterval(tick); stopRecording(); }
  }, 90);
}

function stopRecording() {
  const s = RECORDING;
  if (!s || !s.armed) return;
  s.stop = true;
  try { s.proc.disconnect(); s.stream.getTracks().forEach((t) => t.stop()); s.ctx.close(); } catch {}
  RECORDING = null;
  $("micBtn").disabled = false;

  const secs = s.samples / s.sr;
  if (secs < 1) { $("recorder").hidden = true; return; }

  const blob = encodeWav(s.chunks, s.sr);
  $("recStatus").textContent = `Captured ${secs.toFixed(1)} s`;
  const note = secs < 120
    ? ` — the brief asks for 2–3 minutes, this one is ${secs.toFixed(0)} s`
    : "";
  const file = new File([blob], `browser_recording_${Date.now()}.wav`, { type: "audio/wav" });
  takeFile(file);
  $("pending").textContent =
    `Ready: ${file.name} · ${secs.toFixed(1)} s recorded${note} — analysing now…`;
  analyse(file);
}

function encodeWav(chunks, sampleRate) {
  let length = chunks.reduce((a, c) => a + c.length, 0);
  const buf = new ArrayBuffer(44 + length * 2);
  const v = new DataView(buf);
  const str = (off, s) => { for (let i = 0; i < s.length; i++) v.setUint8(off + i, s.charCodeAt(i)); };
  str(0, "RIFF"); v.setUint32(4, 36 + length * 2, true); str(8, "WAVE");
  str(12, "fmt "); v.setUint32(16, 16, true); v.setUint16(20, 1, true);
  v.setUint16(22, 1, true); v.setUint32(24, sampleRate, true);
  v.setUint32(28, sampleRate * 2, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true);
  str(36, "data"); v.setUint32(40, length * 2, true);
  let off = 44;
  for (const c of chunks) {
    for (let i = 0; i < c.length; i++, off += 2) {
      const s = Math.max(-1, Math.min(1, c[i]));
      v.setInt16(off, s < 0 ? s * 0x8000 : s * 0x7fff, true);
    }
  }
  return new Blob([buf], { type: "audio/wav" });
}

/* ------------------------------------------------------------------ */
/* analyse: POST + read the SSE stream                                 */
/* ------------------------------------------------------------------ */
async function analyse(file) {
  const fd = new FormData();
  fd.append("file", file);
  for (const k of ["min_duration", "merge_gap", "on_margin", "off_margin",
                   "attack", "release", "duration"]) {
    fd.append(k, $(k) ? $(k).value : "");
  }
  fd.append("skip_model", $("skip_model") && $("skip_model").checked ? "1" : "0");

  $("error").hidden = true;
  $("results").hidden = true;
  $("progress").hidden = false;
  $("analyseBtn").disabled = true;
  setStage(1, "active");
  window.scrollTo({ top: $("progress").offsetTop - 90, behavior: "smooth" });

  let res;
  try {
    res = await fetch("/api/analyse", { method: "POST", body: fd });
  } catch (e) {
    return fail("Could not reach the server: " + e.message);
  }
  if (!res.ok || !res.body) {
    const t = await res.text().catch(() => "");
    return fail(`Server error ${res.status}. ${t.slice(0, 300)}`);
  }

  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = "";
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      let i;
      while ((i = buf.indexOf("\n\n")) >= 0) {
        const chunk = buf.slice(0, i);
        buf = buf.slice(i + 2);
        const line = chunk.split("\n").find((l) => l.startsWith("data: "));
        if (!line) continue;
        handle(JSON.parse(line.slice(6)));
      }
    }
  } catch (e) {
    return fail("Stream interrupted: " + e.message);
  } finally {
    $("analyseBtn").disabled = false;
  }
}

function handle(p) {
  if (p.type === "stage") {
    const el = $("s" + p.n);
    const cls = p.status === "done" ? "done" : p.status === "skipped" ? "done" : "active";
    setStage(Number(p.n), cls, p.detail);
    if (p.detail && el) el.textContent = p.detail;
    $("pbarFill").style.width = ((p.n - 1 + (cls === "done" ? 1 : 0)) * 25) + "%";
    if (p.status === "done" && p.n < 4) setStage(p.n + 1, "active");
    if (cls === "done" && p.n === 4) $("pbarFill").classList.add("done");
  } else if (p.type === "result") {
    render(p);
  } else if (p.type === "error") {
    fail(p.message);
  }
}

function setStage(n, cls, detail) {
  document.querySelectorAll(`#progress .step`).forEach((el) => {
    const i = Number(el.dataset.step);
    if (i < n) { el.classList.add("done"); el.classList.remove("active"); }
    if (i === n) { el.className = "step " + cls; }
  });
  if (detail) $("s" + n).textContent = detail;
}

function fail(msg) {
  $("progress").hidden = true;
  $("error").hidden = false;
  $("error").textContent = "Something went wrong — " + msg;
  $("analyseBtn").disabled = false;
}

/* ------------------------------------------------------------------ */
/* render results                                                      */
/* ------------------------------------------------------------------ */
function render(r) {
  LAST = r;
  const s = r.stats;
  $("cEvents").textContent = s.n_events;
  $("cActive").textContent = s.active_pct + "%";
  $("cSpeech").textContent = r.skipped_model ? "—" : s.speech_pct + "%";
  $("cLen").textContent = fmt(r.duration);
  $("sentence").textContent = s.sentence ||
    "No events met the thresholds — try lowering the start margin in Tuning.";

  $("spec").src = r.urls.image + "?t=" + Date.now();
  $("dlCsv").href = r.urls.csv;
  $("dlTxt").href = r.urls.table;
  $("dlSum").href = r.urls.summary;
  $("dlImg").href = r.urls.image;
  $("player").src = r.urls.audio;

  $("counts").innerHTML = (s.counts.length ? s.counts : [])
    .map((c) => `<span class="chip"><b>${esc(c.label)}</b> ×${c.n}<span>${c.seconds}s</span></span>`)
    .join("") || `<span class="muted">Nothing labelled.</span>`;

  ROWS = r.events.slice();
  applySortAndFilter();
  $("rowCount").textContent = `${r.events.length} events · ${fmt(r.duration)} of audio`;

  $("progress").hidden = true;
  $("results").hidden = false;
  $("pending").hidden = true;
  $("analyseBtn").hidden = true;
  window.scrollTo({ top: $("results").offsetTop - 80, behavior: "smooth" });
}

/* ---------------- table: sort, filter, click-to-play --------------- */
function wireTable() {
  document.querySelectorAll("#table thead th").forEach((th) => {
    th.onclick = () => {
      const key = th.dataset.key;
      SORT = { key, dir: SORT.key === key ? -SORT.dir : 1 };
      applySortAndFilter();
    };
  });
  $("filter").oninput = applySortAndFilter;
}

function applySortAndFilter() {
  const q = ($("filter").value || "").toLowerCase().trim();
  let rows = ROWS.filter((e) => !q || e.plain.toLowerCase().includes(q) ||
                                String(e.i).includes(q));
  const { key, dir } = SORT;
  rows = rows.slice().sort((a, b) => {
    let x = key === "runner" ? (a.candidates[1] || {}).label || "" : a[key];
    let y = key === "runner" ? (b.candidates[1] || {}).label || "" : b[key];
    if (typeof x === "string") return dir * x.localeCompare(y);
    return dir * ((x ?? 0) - (y ?? 0));
  });

  document.querySelectorAll("#table thead th").forEach((th) =>
    th.classList.toggle("sorted", th.dataset.key === key));

  const tb = document.querySelector("#table tbody");
  tb.innerHTML = rows.map(rowHtml).join("") ||
    `<tr><td colspan="7" class="runner" style="text-align:center;padding:22px">No events match.</td></tr>`;

  if (LAST) {
    $("rowCount").textContent = (q || rows.length !== ROWS.length)
      ? `${rows.length} of ${ROWS.length} events`
      : `${ROWS.length} events · ${fmt(LAST.duration)} of audio`;
  }

  tb.querySelectorAll("tr[data-i]").forEach((tr) => {
    tr.onclick = () => playAt(Number(tr.dataset.i), Number(tr.dataset.t), tr);
  });
}

function rowHtml(e) {
  const alt = e.candidates[1];
  const pct = Math.round(e.score * 100);
  return `<tr data-i="${e.i}" data-t="${e.start}">
    <td class="num">${e.i}</td>
    <td class="num">${mmss(e.start)}</td>
    <td class="num">${mmss(e.end)}</td>
    <td class="num">${e.dur.toFixed(2)}s</td>
    <td><span class="pill ${e.flagged ? "flag" : ""}">${esc(e.plain)}${e.flagged ? " (?)" : ""}</span></td>
    <td><div class="conf"><div class="bar"><i style="width:${pct}%"></i></div><span class="v">${pct}%</span></div></td>
    <td class="runner">${alt ? esc(alt.label) + " " + Math.round(alt.score * 100) + "%" : "—"}</td>
  </tr>`;
}

function playAt(i, t, tr) {
  document.querySelectorAll("#table tbody tr").forEach((x) => x.classList.remove("playing"));
  tr.classList.add("playing");
  const p = $("player");
  p.currentTime = Math.max(0, t - 0.05);
  p.play().catch(() => {});           // browsers may block until a real gesture
}

/* ------------------------------------------------------------------ */
/* small helpers                                                       */
/* ------------------------------------------------------------------ */
function mmss(s) {
  const m = Math.floor(s / 60), r = s - m * 60;
  return `${String(m).padStart(2, "0")}:${r.toFixed(2).padStart(5, "0")}`;
}
function fmt(s) {
  const m = Math.floor(s / 60), r = Math.round(s - m * 60);
  return `${m}:${String(r).padStart(2, "0")}`;
}
function esc(s) {
  return String(s).replace(/[&<>"]/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
}

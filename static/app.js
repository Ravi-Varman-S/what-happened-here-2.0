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
  // Wire each group independently: a stale cached index.html (missing a
  // newer element) must never take the Record button down with it.
  const failed = [];
  for (const fn of [wireUpload, wireRecorder, wireTable, wireButtons, wireLiveDrag]) {
    try { fn(); } catch (e) { console.error("wire-up failed:", fn.name, e); failed.push(fn.name); }
  }
  if (failed.length && $("error")) {
    $("error").hidden = false;
    $("error").textContent =
      "Some controls failed to load (" + failed.join(", ") + ") — press Ctrl+F5 " +
      "to refresh cached files, then reload this page.";
  }
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
  if ($("lpClose")) $("lpClose").onclick = () => { $("livePopup").hidden = true; };
  $("againBtn").onclick = () => {
    $("results").hidden = true;
    if ($("livePopup")) $("livePopup").hidden = true;
    window.scrollTo({ top: 0, behavior: "smooth" });
  };
}

/* ------------------------------------------------------------------ */
/* live popup: draggable by its header, position remembered            */
/* ------------------------------------------------------------------ */
function clampLivePopup() {
  try {
    const pop = $("livePopup");
    // default corner needs no clamping; only a user-positioned popup does
    if (!pop || pop.hidden || !pop.style.left) return;
    // cancel any running transform animation so the measured rect is true
    try { (pop.getAnimations ? pop.getAnimations() : []).forEach(a => a.cancel()); } catch { /* no Animation API */ }
    const r = pop.getBoundingClientRect();
    // clientWidth/Height exclude the scrollbar — that's the space fixed
    // positioning actually uses (innerWidth would tuck it under the scrollbar)
    const vw = document.documentElement.clientWidth, vh = document.documentElement.clientHeight;
    const x = Math.min(Math.max(6, r.left), Math.max(6, vw - r.width - 6));
    const y = Math.min(Math.max(6, r.top), Math.max(6, vh - r.height - 6));
    pop.style.left = x + "px";
    pop.style.top = y + "px";
  } catch { /* must never break liveStart / resize */ }
}

function wireLiveDrag() {
  const pop = $("livePopup");
  if (!pop || !pop.querySelector) return;
  const head = pop.querySelector(".lp-head");
  if (!head) return;

  // restore a position the user chose earlier
  try {
    const p = JSON.parse(localStorage.getItem("whh.lpPos") || "null");
    if (p && Number.isFinite(p.x) && Number.isFinite(p.y)) {
      pop.style.left = p.x + "px";
      pop.style.top = p.y + "px";
      pop.style.right = "auto";
      pop.style.bottom = "auto";
      clampLivePopup();
    }
  } catch { /* corrupted value: keep the default corner */ }

  let dragging = false, sx = 0, sy = 0, ox = 0, oy = 0;

  head.addEventListener("pointerdown", (e) => {
    if (e.pointerType === "mouse" && e.button !== 0) return;
    if (e.target && e.target.closest && e.target.closest("#lpClose")) return;
    // the entrance animation animates transform, which would skew the rect
    // we measure — cancel it so the drag starts from the true position
    try { (pop.getAnimations ? pop.getAnimations() : []).forEach(a => a.cancel()); } catch { /* no Animation API */ }
    const r = pop.getBoundingClientRect();
    if (!r.width) return;                       // hidden: nothing to grab
    // switch from corner anchoring to explicit position
    pop.style.left = r.left + "px";
    pop.style.top = r.top + "px";
    pop.style.right = "auto";
    pop.style.bottom = "auto";
    dragging = true;
    sx = e.clientX; sy = e.clientY; ox = r.left; oy = r.top;
    try { head.setPointerCapture(e.pointerId); } catch { /* synthetic events */ }
    head.style.cursor = "grabbing";
    pop.style.userSelect = "none";
    if (e.cancelable) e.preventDefault();
  });

  head.addEventListener("pointermove", (e) => {
    if (!dragging) return;
    pop.style.left = (ox + e.clientX - sx) + "px";
    pop.style.top = (oy + e.clientY - sy) + "px";
    clampLivePopup();
  });

  const end = (e) => {
    if (!dragging) return;
    dragging = false;
    head.style.cursor = "";
    pop.style.userSelect = "";
    try { head.releasePointerCapture(e.pointerId); } catch { /* already released */ }
    try {
      const r = pop.getBoundingClientRect();
      localStorage.setItem("whh.lpPos",
        JSON.stringify({ x: Math.round(r.left), y: Math.round(r.top) }));
    } catch { /* private mode: position just won't persist */ }
  };
  head.addEventListener("pointerup", end);
  head.addEventListener("pointercancel", end);

  // double-click the header: snap back to the default bottom-right corner
  head.addEventListener("dblclick", () => {
    pop.style.left = pop.style.top = pop.style.right = pop.style.bottom = "";
    try { localStorage.removeItem("whh.lpPos"); } catch { /* ignore */ }
  });

  window.addEventListener("resize", clampLivePopup);
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
/* live popup: real-time "what is the mic hearing right now"           */
/*                                                                     */
/* Runs inside the recorder's audio callback: block RMS -> rolling     */
/* 25th-percentile noise floor -> 6/4 dB hysteresis (same idea as the  */
/* engine), plus autocorrelation voicing to tell "speaking" from a     */
/* plain "sound". Every event is appended to the feed as it happens    */
/* and the summary stays on screen after the recording ends.           */
/* ------------------------------------------------------------------ */
const LIVE = {
  hist: [],       // recent block levels (dB) for the rolling floor
  cur: null,      // event in progress
  events: [],     // finished events
  speech: 0,      // counts for the closing summary
  sounds: 0,
  above: 0, below: 0,
  freq: null,     // Uint8Array for the analyser bars
  raf: 0,
  key: "",        // last status rendered (dedupe)
  done: false,
  sent: 0,        // recording time of the last chunk posted to /api/live
  busy: false,    // a live label request is in flight
  fails: 0,       // consecutive failures (stop hammering a dead server)
  ident: [],      // top classes from the most recent /api/live answer
  ui: false,      // live popup elements present (a stale page may lack them)
};

function liveStart() {
  Object.assign(LIVE, { hist: [], cur: null, events: [], speech: 0, sounds: 0,
                        above: 0, below: 0, raf: 0, key: "", done: false,
                        sent: 0, busy: false, fails: 0, ident: [] });
  LIVE.ui = !!$("livePopup");
  if (!LIVE.ui) return;               // stale cached page: record without the popup
  $("livePopup").hidden = false;
  clampLivePopup();          // keep a user-moved position inside the viewport
  $("lpTitle").textContent = "Live monitor";
  $("lpDot").className = "lp-dot rec";
  $("lpClock").textContent = "0.0 s";
  $("lpFoot").hidden = true;
  if ($("lpIdent")) $("lpIdent").hidden = true;
  $("lpFeed").innerHTML =
    `<div class="lp-empty">Anything you say or do shows up here as it happens.</div>`;
  const bars = $("lpBars");
  if (bars && !bars.children.length)
    for (let i = 0; i < 28; i++) bars.appendChild(document.createElement("i"));
  liveStatus("quiet", "Getting the microphone…");
}

function liveStatus(cls, html) {
  const k = cls + "|" + html;
  if (LIVE.key === k) return;
  LIVE.key = k;
  const el = $("lpStatus");
  el.className = "lp-status " + cls;
  el.innerHTML = html;
}

/* one audio block (~90 ms) of listening */
function liveTick(d, t, sr) {
  if (!LIVE.ui) return;                                 // no popup on this (cached) page
  let s = 0, zc = 0, prev = 0;
  for (let i = 0; i < d.length; i++) {
    const v = d[i];
    s += v * v;
    if ((v < 0) !== (prev < 0)) zc++;
    prev = v;
  }
  const db = 20 * Math.log10(Math.sqrt(s / d.length) + 1e-9);
  const zcr = zc / d.length;

  LIVE.hist.push(db);
  if (LIVE.hist.length > 60) LIVE.hist.shift();           // ~5 s window
  const floor = pct(LIVE.hist, 25);
  const voice = voicing(d, sr);                            // 0..1 periodicity
  const open = !!LIVE.cur;
  const hot = db > floor + (open ? 4 : 6);                 // same 6/4 dB idea
  const strong = !open && db > floor + 15;                 // a tap/clap opens at once

  if (hot) { LIVE.below = 0; LIVE.above++; } else { LIVE.above = 0; LIVE.below++; }

  if (!open && (strong || LIVE.above >= 2)) {              // ~0.18 s attack (0.09 s if loud)
    LIVE.cur = { start: t, end: t, blocks: 0, voiced: 0, zc: 0, max: -99,
                 label: null, score: 0, blocked: false, top: null };
    ensureLiveRow();
  } else if (open && LIVE.below >= 5) {                    // ~0.43 s release (= v1's merge gap)
    closeLive();
  }

  if (LIVE.cur) {
    const e = LIVE.cur;
    if (hot) {                                             // only loud blocks shape the event
      e.blocks++; e.voiced += voice; e.zc += zcr;
      e.max = Math.max(e.max, db); e.end = t;
    }
    updateLiveRow();
  }

  renderLiveStatus();
  $("lpClock").textContent = t.toFixed(1) + " s";
  readBars();
  maybeSendLive(t);                                        // ask the server what this is
}

const VOICE_TH = 0.6;      // event-mean voicing above this = "speaking"

function liveSpeaking() {
  const e = LIVE.cur;
  return !!e && e.voiced / Math.max(1, e.blocks) > VOICE_TH;
}

/* ------------------------------------------------------------------ */
/* live labelling: the last ~1.8 s of audio goes to /api/live, which   */
/* runs the same YAMNet model as the full analysis, so the popup can   */
/* say "Whistling" / "Bark" instead of only "sound".                   */
/* ------------------------------------------------------------------ */
const LIVE_EVERY = 1.2;     // seconds of new audio between label requests
const LIVE_TAIL = 1.8;      // seconds of audio sent each time

function maybeSendLive(t) {
  const s = RECORDING;
  if (!s || !s.armed || s.stop || LIVE.done || LIVE.busy || LIVE.fails >= 5) return;
  if (t - LIVE.sent < LIVE_EVERY || t < LIVE_TAIL) return;
  LIVE.busy = true;
  LIVE.sent = t;

  const fd = new FormData();
  fd.append("file", new File([tailWav(s, LIVE_TAIL)], "live.wav", { type: "audio/wav" }));
  const t0 = Math.max(0, t - LIVE_TAIL);
  fetch("/api/live", { method: "POST", body: fd })
    .then((r) => { if (!r.ok) throw new Error(r.status); return r.json(); })
    .then((j) => { LIVE.fails = 0; applyLabels(j, t0, t); })
    .catch(() => { LIVE.fails++; })       // server down -> the heuristic labels stay
    .finally(() => { LIVE.busy = false; });
}

function tailWav(state, sec) {
  const want = Math.round(sec * state.sr);
  let need = want;
  const parts = [];
  for (let i = state.chunks.length - 1; i >= 0 && need > 0; i--) {
    const c = state.chunks[i];
    if (c.length <= need) { parts.unshift(c); need -= c.length; }
    else { parts.unshift(c.subarray(c.length - need)); need = 0; }
  }
  return encodeWav(parts, state.sr);
}

function applyLabels(res, t0, t1) {
  if (!res || !res.top || !res.top.length) {
    if (res && res.quiet && !LIVE.cur) { LIVE.ident = []; renderIdent(); }
    return;
  }
  LIVE.ident = res.top;
  renderIdent();

  const ev = eventAt(t0, t1);
  if (!ev) return;
  const best = res.top[0];
  if (best.score < (ev.score || 0)) return;               // keep the stronger answer
  ev.label = best.label;
  ev.score = best.score;
  ev.top = res.top;
  ev.blocked = !!res.blocked_hit;
  if (ev.row) renderRow(ev);
  if (LIVE.done) return;              // a late answer must not touch the summary
  updateLiveRow();
  renderLiveStatus();
}

/* the event (open or already closed) that overlaps this chunk of audio */
function eventAt(t0, t1) {
  const hit = (e) => e && e.end !== undefined && Math.max(e.start, t0) < Math.min(e.end, t1);
  if (hit(LIVE.cur)) return LIVE.cur;
  let best = null;
  for (const e of LIVE.events) if (hit(e)) best = e;
  return best;
}

function renderLiveStatus() {
  const e = LIVE.cur;
  if (!e) { liveStatus("quiet", `<span class="big">🤫</span> Quiet — listening…`); return; }
  const sp = liveSpeaking();
  if (e.label) {
    liveStatus(sp ? "speech" : "sound",
      `<span class="big">${sp ? "🗣" : "🔊"}</span> ${esc(e.label)}` +
      `<span class="lp-pct">${Math.round(e.score * 100)}%</span>`);
    return;
  }
  if (sp) liveStatus("speech", `<span class="big">🗣</span> Speaking`);
  else liveStatus("sound", `<span class="big">🔊</span> Sound detected`);
}

/* the top few classes for the most recent chunk, shown under the status */
function renderIdent() {
  const el = $("lpIdent");
  if (!el) return;
  if (LIVE.done || !LIVE.ident.length) { el.hidden = true; return; }
  el.hidden = false;
  el.innerHTML = `<span class="lp-ident-l">hears</span>` + LIVE.ident.map((c, i) =>
    `<span class="chip${i === 0 ? " top" : ""}">${esc(c.label)} ` +
    `${Math.round(c.score * 100)}%</span>`).join("");
}

/* feed rows -------------------------------------------------------- */
function ensureLiveRow() {
  const feed = $("lpFeed");
  const empty = feed.querySelector(".lp-empty");
  if (empty) empty.remove();
  if ($("lpLive")) return;
  const div = document.createElement("div");
  div.className = "lp-item live";
  div.id = "lpLive";
  div.innerHTML = `<span class="t"></span><span class="k"></span><span class="d"></span>`;
  feed.prepend(div);
}

function keyText(e, speaking) {
  if (e.label) return `${speaking ? "🗣" : "🔊"} ${e.label}${e.blocked ? " (?)" : ""}`;
  return speaking ? "🗣 Speaking" : "🔊 Sound";
}

function updateLiveRow() {
  const row = $("lpLive");
  if (!row || !LIVE.cur) return;
  const e = LIVE.cur;
  const sp = liveSpeaking();
  row.querySelector(".t").textContent = mmss(e.start);
  const k = row.querySelector(".k");
  k.textContent = keyText(e, sp);
  k.className = "k " + (sp ? "sp" : "sn");
  row.querySelector(".d").textContent = (e.end - e.start).toFixed(1) + "s ▸";
}

function renderRow(r) {
  const note = r.label
    ? `${Math.round(r.score * 100)}% sure` +
      (r.top && r.top[1] ? ` · also ${r.top[1].label}` : "") +
      (r.blocked ? " · model unsure" : "")
    : r.note;
  r.row.innerHTML =
    `<span class="t">${mmss(r.start)}</span>` +
    `<span class="k ${r.speaking ? "sp" : "sn"}">${esc(keyText(r, r.speaking))}</span>` +
    `<span class="d">${r.dur.toFixed(1)}s</span>` +
    `<span class="note">${esc(note)}</span>`;
}

function closeLive() {
  const e = LIVE.cur;
  LIVE.cur = null;
  const row = $("lpLive");
  if (row) row.remove();
  if (!e) return;

  const dur = Math.max(0.05, e.end - e.start);
  const n = Math.max(1, e.blocks);
  const speaking = e.voiced / n > VOICE_TH;
  if (speaking) LIVE.speech++; else LIVE.sounds++;

  const rec = { start: e.start, end: e.end, dur, speaking,
                note: speaking ? "voice" : guessSound(dur, e.zc / n),
                label: e.label, score: e.score, blocked: e.blocked, top: e.top };
  const div = document.createElement("div");
  div.className = "lp-item";
  rec.row = div;
  renderRow(rec);
  const feed = $("lpFeed");
  const second = feed.children[1] || null;
  feed.insertBefore(div, second);                          // newest just under the live row
  LIVE.events.push(rec);
}

/* a plain-language guess for a non-speech sound, from its shape */
function guessSound(dur, zcr) {
  if (dur < 0.5) return zcr < 0.06 ? "short & low — a thud, knock or door?" :
                                   "short & sharp — a tap, clap or clack?";
  if (zcr > 0.18) return "bright — rustle, sh, hiss or fan?";
  if (zcr < 0.06) return "low & sustained — engine, music bass or rumble?";
  return "movement / background noise";
}

/* voicing strength: ~1 = a pitched, voice-like tone.
   Normalised square-difference over two half-windows (42 ms each) so pitch
   drift inside the block cannot smear the correlation away; lag range is
   75–350 Hz, the speaking range. Scored against YAMNet labels on a real
   94 s room recording: speech blocks 0.84 median, quiet/other events 0.42. */
function voicing(d, sr) {
  const dec = Math.max(1, Math.round(d.length / 1024));
  const n = Math.floor(d.length / dec);
  if (n < 128) return 0;
  const x = new Float32Array(n);
  let mean = 0;
  for (let i = 0; i < n; i++) { x[i] = d[i * dec]; mean += x[i]; }
  mean /= n;
  let e0 = 0;
  for (let i = 0; i < n; i++) { x[i] -= mean; e0 += x[i] * x[i]; }
  if (e0 < 1e-7) return 0;

  const fs = sr / dec;
  const h = n >> 1;
  const minLag = Math.max(1, Math.floor(fs / 350));
  const maxLag = Math.min(h - 2, Math.floor(fs / 75));
  let best = 0;
  for (let lag = minLag; lag <= maxLag; lag++)
    best = Math.max(best, nsdfAt(x, 0, h, lag), nsdfAt(x, h, h, lag));
  return Math.max(0, Math.min(1, best));
}

function nsdfAt(x, from, len, lag) {
  let ns = 0, ea = 0, eb = 0;
  for (let i = from; i + lag < from + len; i++) {
    const a = x[i], b = x[i + lag];
    ns += a * b; ea += a * a; eb += b * b;
  }
  return 2 * ns / (ea + eb + 1e-12);
}

/* frequency bars: the rAF loop keeps them smooth while the tab is visible,
   and liveTick refreshes them too, so they still move if rAF is throttled */
function readBars() {
  const a = RECORDING && RECORDING.analyser;
  if (!a || !LIVE.freq) return;
  a.getByteFrequencyData(LIVE.freq);
  liveDraw();
}

/* frequency bars, drawn from the analyser on animation frames.
   Bars are mapped log-wise from 60 Hz to 10 kHz, so speech spreads across
   the display instead of piling into the first couple of bars. */
function liveDraw() {
  const bars = $("lpBars").children;
  const bins = LIVE.freq;
  if (!bins || !LIVE.sr || !bars.length) return;
  if (!LIVE.barIdx || LIVE.barIdx.length !== bars.length) {
    const binHz = LIVE.sr / (2 * bins.length);
    LIVE.barIdx = [];
    for (let i = 0; i < bars.length; i++) {
      const f = 60 * Math.pow(10000 / 60, i / (bars.length - 1));
      LIVE.barIdx.push(Math.min(bins.length - 2, Math.max(1, Math.round(f / binHz))));
    }
  }
  for (let i = 0; i < bars.length; i++) {
    const v = bins[LIVE.barIdx[i]] / 255;
    bars[i].style.transform = `scaleY(${Math.max(0.05, v).toFixed(3)})`;
    bars[i].classList.toggle("hot", v > 0.7);
  }
}

/* the recording stopped: freeze the feed and show what was heard        */
/* Must never throw: stopRecording calls this before uploading, so a     */
/* broken popup would otherwise also kill the analysis.                  */
function liveFinish(secs) {
  LIVE.done = true;
  cancelAnimationFrame(LIVE.raf);
  if (!LIVE.ui) return;                        // stale cached page: skip the popup
  try {
    if (LIVE.cur) closeLive();
    $("lpTitle").textContent = "Recording finished";
    $("lpDot").className = "lp-dot done";
    $("lpClock").textContent = secs.toFixed(1) + " s";
    const total = LIVE.events.length;
    const bits = [];
    if (LIVE.speech) bits.push(`${LIVE.speech} speaking`);
    if (LIVE.sounds) bits.push(`${LIVE.sounds} other`);
    const named = {};
    for (const e of LIVE.events) if (e.label) named[e.label] = (named[e.label] || 0) + 1;
    const tally = Object.entries(named).sort((a, b) => b[1] - a[1]).slice(0, 4)
      .map(([l, n]) => `${l} ×${n}`).join(" · ");
    renderIdent();                                        // hides the "hears" line
    liveStatus("done", total
      ? `✅ Heard <b>&nbsp;${total}&nbsp;</b> live event${total > 1 ? "s" : ""} in ${secs.toFixed(0)} s — `
        + `${bits.join(" · ")}.` + (tally ? ` YAMNet heard: <b>${esc(tally)}</b>.` : "")
        + ` The full analysis is below.`
      : `✅ ${secs.toFixed(0)} s recorded — nothing loud enough to flag live.`);
    if (!total)
      $("lpFeed").innerHTML =
        `<div class="lp-empty">No live events — the engine below may still find more.</div>`;
    $("lpFoot").hidden = false;
  } catch (e) {
    console.error("live popup summary failed:", e);
  }
}


function pct(arr, p) {
  const a = arr.slice().sort((x, y) => x - y);
  const i = (p / 100) * (a.length - 1);
  const lo = Math.floor(i), hi = Math.ceil(i);
  return a[lo] + (a[hi] - a[lo]) * (i - lo);
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

  const analyser = ctx.createAnalyser();                   // feeds the live bars
  analyser.fftSize = 512;
  analyser.smoothingTimeConstant = 0.7;
  src.connect(analyser);
  const anSink = ctx.createGain();                         // 0-gain sink: a branch with no
  anSink.gain.value = 0;                                   // destination is never pulled and
  analyser.connect(anSink);                                // would report digital silence
  anSink.connect(ctx.destination);

  const state = {
    ctx, stream, proc, sr, analyser, chunks: [], samples: 0, peak: 0, clipped: false,
    t0: 0, armed: false, stop: false,
  };
  RECORDING = state;

  LIVE.freq = new Uint8Array(analyser.frequencyBinCount);
  LIVE.sr = sr;
  liveStart();
  const draw = () => {
    if (RECORDING !== state || state.stop) return;
    analyser.getByteFrequencyData(LIVE.freq);
    liveDraw();
    LIVE.raf = requestAnimationFrame(draw);
  };
  LIVE.raf = requestAnimationFrame(draw);

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
      liveTick(d.subarray(0, n), state.samples / sr, sr);
    }
    if (state.samples >= Math.round(180 * sr)) stopRecording();
  };

  $("recorder").hidden = false;
  $("micBtn").disabled = true;
  $("recHint").textContent = "Speak, move things, close a door — make it sound like a real room.";

  // 3-second countdown, then arm the capture (the task wants 2–3 minutes)
  for (let n = 3; n > 0; n--) {
    $("recStatus").textContent = `Starting in ${n}…`;
    liveStatus("quiet", `<span class="big">⏳</span> Starting in ${n}…`);
    readBars();
    await new Promise((r) => setTimeout(r, 1000));
    if (RECORDING !== state) return;             // user bailed out
  }
  state.armed = true;
  state.t0 = performance.now();
  $("recStatus").textContent = "Recording";
  LIVE.key = "";                                  // force the first live status

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
  if (!s) return;
  if (!s.armed) {                                  // bailed out during the countdown
    s.stop = true;
    cancelAnimationFrame(LIVE.raf);
    try { s.proc.disconnect(); s.stream.getTracks().forEach((t) => t.stop()); s.ctx.close(); } catch {}
    RECORDING = null;
    $("micBtn").disabled = false;
    $("recorder").hidden = true;
    $("livePopup").hidden = true;
    return;
  }
  s.stop = true;
  cancelAnimationFrame(LIVE.raf);
  try { s.proc.disconnect(); s.stream.getTracks().forEach((t) => t.stop()); s.ctx.close(); } catch {}
  RECORDING = null;
  $("micBtn").disabled = false;

  const secs = s.samples / s.sr;
  if (secs < 1) { $("recorder").hidden = true; $("livePopup").hidden = true; return; }

  liveFinish(secs);                                // freeze the feed, show the summary
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

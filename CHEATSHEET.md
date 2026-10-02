# What Happened Here? 2.0 — Code Cheatsheet

Every section of the codebase, mapped to its exact line numbers.
Open any file in VS Code → **Ctrl+G** → type the line → land there.

---

## Big picture

```
User drops / records audio
        │
        ▼
static/index.html ──static/app.css (skin)── static/app.js (behavior)
        │                                         │  POST /api/live   (every 1.2 s — live labels)
        │                                         │  POST /api/analyse (4-stage SSE)
        ▼                                         ▼
                        server.py  (FastAPI: routes, SSE, caching, warm-up)
                                │
                                ▼
                        engine.py  (detect by hand → label with YAMNet → report)
```

| File | Lines | Role |
|---|---|---|
| `server.py` | 428 | Web server: routes, SSE stream, live endpoint, model lifecycle |
| `engine.py` | 682 | The brain: load → detect → label → report (+ CLI) |
| `static/index.html` | 237 | Markup: every ID/section, plain HTML, always `hidden` until JS shows it |
| `static/app.css` | 640 | Skin: "forensic audio workstation" — pure CSS over untouched markup |
| `static/app.js` | 943 | Behavior: upload, record, live labels, SSE, table |
| `test_web.py` | 127 | 6-section test suite → "ALL PASSED" |
| `start_app.bat` / `run.bat` / `open_ui.py` | 23 / 46 / — | Launchers (double-click → server + browser) |
| `Dockerfile` / `README.md` | 27 / 133 | Hugging Face Space deploy (Docker SDK) |

### API endpoints

| Route | Line (server.py) | Does |
|---|---|---|
| `GET /` | 272 | Serves `index.html` |
| `GET /api/config` | 277 | Engine defaults (the knobs the UI renders) |
| `POST /api/live` | 296 | Labels the last 1.8 s of mic audio (YAMNet top-4) |
| `POST /api/analyse` | 360 | Full pipeline, streams 4 stages as SSE, writes `/results/{rid}/*` |
| `GET /results/{rid}/{fname}` | 407 | Spectrogram, CSV, table, summary, audio |
| `@app.middleware` | 48 | `Cache-Control: no-cache` on everything |

### Key constants

| Value | Where | Meaning |
|---|---|---|
| `TARGET_SR = 16000` | engine.py:21 | YAMNet's native sample rate |
| `FRAME 25 ms / HOP 10 ms` | engine.py:26–27 | Energy-curve resolution |
| `BASELINE 5 s, 25th pct` | engine.py:39–40 | Adaptive ambient-noise floor |
| `ON +6 dB / OFF −4 dB` | engine.py:41–42 | Open / close an event (hysteresis) |
| `attack/release 0.10 s` | engine.py:32–33 | Hold times either side |
| `MIN_CONFIDENCE = 0.20` | engine.py:46 | Below this = "unlabelled" (**also gates live labels**) |
| `NON_EVENT_LABELS` | engine.py:37 | Silence/Noise/Static can never label a detected event |
| `LIVE_EVERY = 1.2 s` | app.js:299 | Live label request cadence |
| `LIVE_TAIL = 1.8 s` | app.js:300 | Audio window sent each time |
| `VOICE_TH = 0.6` | app.js:287 | Voicing above this = "speaking" |
| `task_min/max 120/180 s` | server.py (`/api/config`) | The 2–3 minute brief |

---

## 1. `server.py` (428 lines)

| Lines | Section | What the code does |
|---|---|---|
| 1–46 | **imports & app** | FastAPI app, `StaticFiles`, imports `engine as E` (L37); TF kept quiet via engine |
| **48–61** | **no-cache middleware** | Every response gets `Cache-Control: no-cache` → fixes reach you without cache fights |
| **63–90** | **model lifecycle** | `labeller()` (L67): load YAMNet once, reuse. `_warm_model()` (L79) + startup hook (L87): loads it at boot so the first live label isn't slow. `_LIVE_LOCK` (L76): one inference at a time |
| 92–155 | **helpers** | `_num()` (L96) clamps form values · `_sse()` (L109) formats SSE frames · `_clean_name()` (L113) safe filenames · `_stats()` (L117) computes the sentence, counts, speech % |
| **156–267** | **`_analyse()` — the SSE pipeline** | Stage 1 decode/normalise (uses `E.load_and_clean`) → stage 2 detect (`E.detect_events`, L199 runs under the lock) → stage 3 YAMNet labels → stage 4 spectrogram + files. Yields `_sse({type:"stage"...})` then `{type:"result"}` |
| **268–428** | **routes** | `/` L272 · `/api/config` L277 · **`/api/live` L296** (below) · `/api/analyse` L360 (parses multipart + params → `_analyse` → stream) · `/results/*` L407 |

### `POST /api/live` (L296–358) — the live-label endpoint

```
L307  read upload bytes          → reject < 2000 B (400)
L311  write temp .wav, soundfile decode → mono
L321  rms gate                   → very quiet? return {top: [], quiet: true}
L332  model = labeller()         → loads YAMNet on first call if boot warm-up didn't
L333  with _LIVE_LOCK:           → one inference at a time (full analysis may be running)
      score every 0.96 s window over the last ~1.8 s (max, not mean → short bark wins)
L345  ranked[blocked] = -1.0     → Silence/Noise/Static can never win
L346  top 4 with score > 0.02    → JSON {top, quiet, rms_db, blocked_hit}
```

---

## 2. `engine.py` (682 lines) — the 4-step pipeline

| Lines | Section | Functions |
|---|---|---|
| 1–16 | **imports** | TF warnings silenced **before** TF import (L11) |
| **17–50** | **Configuration** | `TARGET_SR` L21 · normalise target L22–23 · frame/hop L26–27 · detector defaults L30–33 · `NON_EVENT_LABELS` L37 · baseline L39–42 · YAMNet window/hop L44–45 · `MIN_CONFIDENCE 0.20` L46 · speech threshold L48 |
| **51–69** | **Data structures** | `@dataclass Event` L56: `start, end, label, score, candidates, peak_db, mean_db, flagged` · `duration()` L66 |
| **70–149** | **① Load & clean** | `decode_to_array()` L74 (soundfile, **ffmpeg fallback** L92 for stubborn formats) · `resample()` L113 · `normalize()` L121 (−26 dB RMS, peak 0.99 ceiling) · `load_and_clean()` L133 = the one entry point |
| **150–315** | **② Detect, by hand** | `energy_curve()` L154: 25 ms frames → RMS → dB → smooth L181 · `_rolling_percentile()` L193: the adaptive floor · `adaptive_thresholds()` L221: floor±margins · **`detect_events()` L238**: gate open/close with attack/release → merge gaps → drop blips → returns `Event[]` |
| **316–395** | **③ Label with YAMNet** | `YamnetLabeller` L320: lazy TF-Hub load · `scores()` L334: full-file window scores · `top_k()` L347 · **`label_events()` L353**: mean score of windows inside each event; below `MIN_CONFIDENCE` or favourite = non-event → `flagged` "(?)" |
| **396–588** | **④ Reporting** | `plot_spectrogram()` L400: two panels — waveform+event shading, dB curve+floor+thresholds · `print_table()` L499 · `save_csv()` L521 · `statistics()` L534: active %, speech %, counts, the plain-English sentence |
| **589–682** | **CLI** | `main()` L593: `python engine.py file.wav` prints everything (v1 behaviour still works) |

---

## 3. `static/index.html` (237 lines)

| Lines | Section | Key IDs |
|---|---|---|
| 1–12 | **head** | IBM Plex fonts (L9), `app.css?v=` (L10), emoji favicon (L11) |
| 15–24 | topbar | brand ◧, nav links |
| **29–99** | **hero + input** | `#dropzone` L37 (drop/click) · `#fileInput` L39 · `#micBtn` L47 🎙 · **`#recorder` L53** (dot, `#recStatus`, `#recStop` L58, `#meterFill` L61, `#recTime/#recPeak/#recHint`) · `#tuning` L72 (8 engine knobs + `#skip_model`) · `#analyseBtn` L95 · `#pending` L98 |
| **101–112** | **progress** | 4 `.step[data-step]` with live text `#s1..#s4` + `#pbarFill` L111 |
| 114 | error | `#error` |
| **117–183** | **results** | stat cards `#cEvents #cActive #cSpeech #cLen` L120–123 · `#sentence` L126 · panel 1 spectrogram `#spec` + downloads `#dlCsv/#dlTxt/#dlSum/#dlImg` + `#player` L143 · panel 2 table `#filter` L150, `#table` L155 (7 sortable `data-key` columns) · panel 3 `#counts` chips L177 · `#againBtn` L181 |
| 186–204 | how it works | 4 static explainer cards |
| **209–227** | **live popup** | `#livePopup` (aria-live) → `#lpDot #lpTitle #lpClock #lpClose` L211–215 · **`#lpStatus` L217** (🗣/🔊/🤫 line) · **`#lpIdent` L218** ("hears" chips) · `#lpBars` L219 (freq bars) · `#lpFeed` L220 (event rows) · `#lpFoot` L223 |
| 229–233 | footer | v1 credit |
| **235** | **script** | `app.js?v=20261002a` ← the live-fix version |

---

## 4. `static/app.css` (640 lines)

| Lines | Section | Notes |
|---|---|---|
| 1–15 | header | Skin manifesto + palette legend (cyan=active, violet=speech, amber=guess, red=REC) |
| **17–39** | **tokens** | `:root` everything (`--bg --panel --accent --red --ok --radius --mono…`) · `[hidden]{display:none!important}` L38 (**JS toggles must always win**) |
| **41–87** | **page ground** | graph grid + noise + glow (L47–51) · **`body::before` L54: animated time-ruler playhead** (the signature) · `body::after` L67 vignette · focus/selection/scrollbar L72–77 · `.grad` L82 headline gradient |
| 89–123 | topbar | instrument header |
| 124–132 | hero | `.lede`, `.grad` |
| **133–187** | **dropzone** | styled as an empty waveform viewport + crosshair corners (L148) |
| 188–217 | buttons | `.btn .primary .ghost .small .big` |
| **218–262** | **recorder** | LED dot pulse, `.meter-fill`, **frequency-tick strip** (L226), LED block separators (L253) |
| 263–292 | tuning | `<details>` drawer grid |
| 293–353 | progress | stage LEDs · ticked scrub bar with scanning fill (L327) |
| 354–404 | results cards | scale marks down the right edge (L373) |
| 405–495 | panels | glowing measurement bezel around the spectrogram (L444) |
| **496–593** | **live popup** | `.live-popup` glass card · `.lp-status.quiet/.speech/.sound` colors · `.lp-ident .chip` · `.lp-bars` · `.lp-feed .lp-item` rows · REC dot |
| 594–636 | how it works | `.stepcard`s |
| **637–640** | **accessibility** | `:focus-visible` ring, reduced-motion, high-contrast |

---

## 5. `static/app.js` (943 lines)

| Lines | Section | Functions (line) |
|---|---|---|
| 1–13 | header + globals | `$` L6 · `CONFIG PENDING LAST ROWS SORT RECORDING` L8–13 |
| **15–59** | **boot** | `init()` L20: fetch `/api/config`, then wire 5 groups **each in try/catch** (a stale cache can't kill the Record button) · `resetParams()` L42 · `wireButtons()` L50 |
| **61–153** | **popup drag** | `clampLivePopup()` L64 · `wireLiveDrag()` L82: drag by header, position saved to localStorage |
| **154–183** | **upload** | `wireUpload()` L157: drop/click/choose · `takeFile()` L175: validates, shows `#analyseBtn` |
| **184–588** | **live popup engine** | *see the detailed map below* |
| **589–743** | **recorder** | `wireRecorder()` L592 · **`startRecording()` L597**: getUserMedia → 3 s countdown → ScriptProcessor(4096) → analyser → `liveStart()` L620 · `onaudioprocess` L629: push chunk, peak meter, `liveTick()` L640, 180 s hard cap L642 · **`stopRecording()` L689**: teardown → `liveFinish(secs)` L711 → `encodeWav` L712 → `analyse(file)` L721 · `encodeWav()` L724: hand-written RIFF/int16 writer |
| **744–829** | **analyse (SSE)** | `analyse()` L747: POST multipart + params → read body stream → split on `\n\n` → `handle()` L798 dispatches `stage/result/error` · `setStage()` L814 animates the 4 steps + progress bar · `fail()` L823 |
| **830–864** | **render results** | `render()` L833: cards, sentence, `#spec.src`, download links, player, count chips, `ROWS` → table |
| **865–928** | **table** | `wireTable()` L866: header click = sort · `applySortAndFilter()` L877 · `rowHtml()` L907 (confidence bar, `(?)` pill) · `playAt()` L921: row click → player jumps to that second |
| **929–943** | **helpers** | `mmss()` L932 · `fmt()` L936 · `esc()` L940 (HTML-escape — all external text goes through it) |

### Live popup engine in detail (app.js L184–588)

| Lines | Function | Does |
|---|---|---|
| 193–209 | **`const LIVE`** | all state: `cur, events, ident, hist, sent, busy, fails (L206), ui, done` |
| 211–230 | `liveStart()` | per-recording reset: `sent:0 busy:false fails:0 ident:[]`, builds 24 bars |
| 232–239 | `liveStatus()` | writes `#lpStatus` (deduped by key) |
| **242–285** | **`liveTick(d,t,sr)`** | the ~90 ms heartbeat: RMS dB + zero-cross L244–252 → rolling floor L254–256 → gate (6/4 dB, +15 for claps) L259–260 → open/close event L264–270 → accumulate L272–279 → paint status/clock/bars L281–283 → **`maybeSendLive(t)` L284** |
| 287–292 | `liveSpeaking()` | mean voicing > 0.6 = 🗣 |
| 299–300 | constants | `LIVE_EVERY 1.2`, `LIVE_TAIL 1.8` |
| **302–321** | **`maybeSendLive(t)`** | guards L304 → **backoff: `every = fails>=5 ? 15 : 1.2` L308 (Fix A)** → tail WAV → `POST /api/live` L316 → `fails=0` on success L318, `fails++` on error L319, `busy=false` in `finally` L320 |
| 323–333 | `tailWav()` | last 1.8 s of chunks → WAV bytes |
| **335–359** | **`applyLabels(res,t0,t1)`** | empty → **clear chips on quiet L337 (Fix B)** → store `LIVE.ident` + render L341–342 → find overlapping event L344 (`eventAt` L361) → **floor: `score ≥ CONFIG.confidence (0.2)` L347–348 (Fix B)** → keep stronger answer L349 → assign `ev.label/score/top/blocked` L350–353 → repaint L354–357 (never after `done`) |
| **369–386** | **`renderLiveStatus()`** | no event → **hide chips L371–376 (Fix C)** + "🤫 Quiet" · event + label → "🗣 label NN%" L378–383 · no label → "🗣 Speaking" / "🔊 Sound" |
| **389–400** | **`renderIdent()`** | gate **L395 (Fix C)**: hidden when `done` OR empty OR quiet → else builds the `hears: [chip][chip]…` HTML |
| 402–469 | feed rows | `ensureLiveRow()` L403 (live row) · `keyText()` L415 · `updateLiveRow()` L420 · `renderRow()` L432 · `closeLive()` L445: close → speech/other count → history row inserted |
| 470–514 | sound guess + voicing | `guessSound()` L471 (duration+ZCR → "Click/Clatter/Rumble…") · `voicing()` L484 + `nsdfAt()` L506 (autocorrelation pitch strength) |
| 515–545 | frequency bars | `readBars()` L517 (analyser snapshot) · `liveDraw()` L527 (log 60 Hz–10 kHz mapping, rAF) |
| **546–588** | **`liveFinish(secs)`** | freeze feed → summary "✅ Heard N live events… YAMNet heard: X ×n" → hide chips (`done`) |
| 582–588 | `pct()` | percentile helper for the floor |

---

## 6. `test_web.py` (127 lines)

| Lines | Section | Checks |
|---|---|---|
| 1–28 | helpers | `BASE` L8 · `sample()` L12 · `check()` L24 (prints PASS/FAIL, tracks `ok`) |
| **30–34** | **§1 static + config** | `GET /` contains app markers · `GET /api/config` defaults |
| **36–67** | **§2 analyse** | full street-clip pipeline: 200, `text/event-stream`, all 4 stages, result payload, events>0, stats match, labels present, speech % |
| **69–78** | **§3 files** | spectrogram/CSV/table/summary/audio all 200 · CSV header + row count |
| **80–93** | **§4 fast path** | `skip_model=1` → detection still runs, no model |
| **95–120** | **§5 live** | `POST /api/live` 200 · top classes · scores ∈ [0,1] · **silence → `quiet:true`** |
| 122–124 | §6 rejection | non-audio upload → 400 |
| 126 | verdict | `ALL PASSED` |

Run: `python test_web.py` (server must be up on :8000).

---

## 7. Launchers & deploy

| File | Lines | Does |
|---|---|---|
| `start_app.bat` | 23 | **Double-click entry.** Server already up? → just open browser ("hot"). Else → `ping -n 4` settle → call `run.bat` → open browser when ready ("cold"). Desktop shortcut points here |
| `run.bat` | 46 | venv activate → `python -m uvicorn server:app --port 8000` (blocking — run it in its own window) |
| `open_ui.py` | — | Waits for `:8000` to answer, then `webbrowser.open` |
| `Dockerfile` | 27 | HF Space image: Python base → pip install → uvicorn on `$HOST:$PORT` |
| `README.md` | 133 | `sdk: docker` front-matter (makes it a Hugging Face Space) + docs |

---

## 8. The live-label fix (commit `39e43f1`)

| Fix | File:Line | One-liner |
|---|---|---|
| **A. failure backoff** | app.js:304–309 | 5 failed sends no longer kill labels forever — probes every 15 s, one success restores 1.2 s cadence |
| **B. confidence floor** | app.js:347–348 | No label below `CONFIG.confidence` (0.2) — no more "Ice cream truck 22%" over speech; quiet answers also clear the chips (L337) |
| **C. stale-chip hiding** | app.js:371–376, 395 | "hears" chips hide whenever status says Quiet — never contradict it |
| version bump | index.html:235 | `app.js?v=20261002a` |

---

## 9. Golden rules & gotchas

1. **HTML = structure/IDs · CSS = skin · JS = behavior.** Reskins touch only `app.css`; selectors are parity-checked against the previous version.
2. **All external text through `esc()`** (app.js:940) — labels, filenames, messages.
3. **`[hidden]{display:none!important}`** (app.css:38) — class styles must never beat JS visibility toggles.
4. **One YAMNet at a time** — `_LIVE_LOCK` (server.py:76) serialises live + full-analysis inference.
5. **Detector rules over model ego** — `NON_EVENT_LABELS` (engine.py:37): Silence/Noise/Static can never label what the detector already proved is sound (marked `(?)` otherwise).
6. **PowerShell 5.1**: no `&&`, no ternary; block the server with `Start-Process`, never in the foreground.
7. **Refresh with Ctrl+F5** if the UI looks stale — `init()` (app.js:28–39) even tells you when a cached page is the problem.
```

---
sdk: docker
---

# What Happened Here? 2.0

Same project, now in a browser. Give it a 2–3 minute recording of an everyday
setting and it tells you what happened and when — a labelled spectrogram, a
timing table, and the loudness curves that justify every boundary.

The interesting bit hasn't changed: `engine.py` in this folder is a
**byte-for-byte copy of v1's `what_happened_here.py`**, so the detector, the
thresholds and the YAMNet labelling behave exactly as they always did. All the
new work is the web layer around it.

## Run it — one command

```
run.bat            (Windows)      ./run.sh            (macOS / Linux)
```

That starts the server on <http://127.0.0.1:8000> and opens a browser. First
run creates a virtual environment and installs `requirements.txt`; afterwards
the same command just starts. `run.bat 9000` uses a different port, and
`Ctrl+C` stops the server.

## What you get in the browser

- **An instrument-bench UI** — the page is skinned as an oscilloscope: a phosphor
  graticule background with CRT scanlines and a signal rail sweeping across the
  top, glowing green/cyan monospace readouts (JetBrains Mono) under technical
  display headings (Space Grotesk), a reticle-cornered dropzone, an LED-segment
  level meter, and every section drawn like a rack module. Pure CSS over the
  same markup, with system-font fallbacks when offline.
- **Drag and drop** a wav/mp3/ogg/flac/m4a, or **record straight from the
  microphone** — countdown, live level meter with a clipping warning, hard cap
  at 180 s, encoded to WAV in the page and uploaded automatically.
- **Live progress** through the four stages, streamed from the server as each
  step finishes, with a real detail line (`33 events found`, `374 windows
  analysed`).
- **Stat cards** — events found, share of the recording that was active,
  speech coverage, length analysed — plus a one-sentence summary.
- **The spectrogram** with every event shaded and numbered, and the loudness /
  threshold panel underneath. A built-in audio player sits below it: click any
  table row and it seeks to that moment.
- **A sortable, searchable event table** with confidence bars, runner-up labels
  and an amber `(?)` badge whenever the model was guessing.
- **Downloads**: CSV, plain-text table, summary, and the original image.
- **Live popup while you record** — a floating monitor that reacts to the room
  in real time: a big 🤫 *Quiet* / 🔊 *Sound detected* / 🗣 *Speaking* status,
  animated level bars (log-mapped 60 Hz–10 kHz), and a running feed of every
  event the moment it happens (`00:05.4 🗣 Speaking 2.6s · voice`,
  `00:01.4 🔊 Sound 0.1s · short & sharp — a tap, clap or clack?`). When you
  stop, it flips to a summary of what it heard — *“Heard 9 live events in 25 s —
  6 speaking · 3 other”* — and stays on screen next to the full analysis. It is
  the same 6/4 dB hysteresis as the engine, run block-by-block in the browser,
  plus a pitch-strength test to tell a voice from a bang (tuned against YAMNet's
  labels on a 94-second room recording).
- **Tuning panel** with every detector parameter exposed — the same numbers as
  v1 (`+6 dB` start, `+4 dB` stop, `0.10 s` attack/release, `0.40 s` merge,
  `0.10 s` minimum), read from the engine at `/api/config` so the UI can never
  drift out of sync with the code.

## How it works

| # | Step | Where |
|---|------|-------|
| 1 | Load & clean: decode (ffmpeg fallback) → mono → 16 kHz → normalise to −26 dB RMS | `engine.py` |
| 2 | Detect start/stop: hand-written energy detector, rolling 25th-percentile floor, 6/4 dB hysteresis, 100 ms debounce | `engine.py` |
| 3 | Label: YAMNet, 521 AudioSet classes, Silence/Noise/Static ruled out, `(?)` on low confidence | `engine.py` |
| 4 | Report: spectrogram + table + CSV + summary statistics | `engine.py` + `server.py` |
| + | Upload, streaming progress, table UI, browser recording | `server.py`, `static/` |

Steps 1–3 are not reimplemented for the web — they *are* v1.

## API

```
GET  /                     the web app
GET  /api/config           engine defaults (source of truth for the tuning panel)
POST /api/analyse          multipart: file + parameters -> SSE stream
                            event: stage {n, status, detail}
                            event: result {events, stats, urls, params}
GET  /results/<id>/...     spectrogram.png, events.csv, events.txt,
                            summary.txt, and the uploaded audio
GET  /api/docs             interactive OpenAPI docs
```

```bash
curl -N -F file=@audio/street_3min.wav -F on_margin=6 \
     http://127.0.0.1:8000/api/analyse
```

## Files

```
run.bat / run.sh      one command: set up, start, open the browser
open_ui.py            waits for the server, then opens the tab
server.py             FastAPI app: upload, SSE progress, results
engine.py             the v1 analysis engine, unmodified
static/index.html     the UI
static/app.css
static/app.js
test_web.py           20-check smoke test against a running server
audio/                two 3-minute public-domain demo clips to drag in
requirements.txt
```

## Testing

With the server running:

```
python test_web.py
```

It checks the static app, the config endpoint, a full streamed analysis of the
street clip (stage events, result payload, all generated files, CSV row count),
the `skip_model` fast path, and that non-audio uploads are rejected. The street
clip comes out at **33 events, 16.2% active** — the same result v1 produces,
which is the whole point.

## Requirements

Python 3.10+ and `pip install -r requirements.txt`. YAMNet is fetched from
TensorFlow Hub on the first analysis and cached afterwards.

v1 (the command-line original) lives at
<https://github.com/Ravi-Varman-S/what-happened-here>, including the write-up
of the approach, where it fails and what I'd improve.

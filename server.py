"""
What Happened Here? 2.0 — web server
====================================

Serves the *exact* v1 analysis engine (`engine.py`, byte-identical to the
original `what_happened_here.py`) behind a browser UI.

    GET  /                      the web app
    GET  /api/config            engine defaults, so the UI and engine can't drift
    POST /api/analyse           upload a recording -> SSE stream of 4 stages + result
    GET  /results/<id>/...      generated spectrogram, CSV, table, summary, audio

Run with:  python server.py     (or run.bat / run.sh, which also opens a browser)
"""

from __future__ import annotations

import contextlib
import io
import json
import os
import re
import shutil
import tempfile
import threading
import uuid
import warnings
from pathlib import Path

os.environ.setdefault("TF_CPP_MIN_LOG_LEVEL", "3")
warnings.filterwarnings("ignore")

from fastapi import FastAPI, File, Form, HTTPException, UploadFile
from fastapi.responses import FileResponse, StreamingResponse
from fastapi.staticfiles import StaticFiles

import engine as E
import numpy as np

ROOT = Path(__file__).resolve().parent
RESULTS = ROOT / "results"
STATIC = ROOT / "static"
RESULTS.mkdir(exist_ok=True)

app = FastAPI(title="What Happened Here? 2.0", docs_url="/api/docs")


@app.middleware("http")
async def _no_stale_assets(request, call_next):
    """Always revalidate the page and its assets.

    Without this the browser may heuristically cache index.html and app.js
    *separately* and later run a new script against an old page — which
    breaks the app in confusing ways (e.g. "the Record button does
    nothing").  no-cache still allows 304 revalidation, so it costs
    nothing on normal loads.
    """
    response = await call_next(request)
    if request.url.path == "/" or request.url.path.startswith("/static/"):
        response.headers["Cache-Control"] = "no-cache"
    return response

# The model takes a few seconds to load, so it is built once and reused.
_LABELLER: E.YamnetLabeller | None = None


def labeller() -> E.YamnetLabeller:
    global _LABELLER
    if _LABELLER is None:
        _LABELLER = E.YamnetLabeller()
    return _LABELLER


# Inference runs in FastAPI's worker threads; TensorFlow is happiest with one
# call at a time, and the live endpoint and the full analysis may overlap.
_LIVE_LOCK = threading.Lock()


def _warm_model() -> None:
    """Start loading YAMNet at boot so the first live label is not a long wait."""
    try:
        labeller()
    except Exception:                                   # pragma: no cover
        pass


@app.on_event("startup")
def _startup() -> None:
    threading.Thread(target=_warm_model, daemon=True).start()


# --------------------------------------------------------------------------- #
# helpers
# --------------------------------------------------------------------------- #

def _num(raw, default, cast=float, lo=None, hi=None):
    """Parse a form value defensively: blank/invalid -> default, then clamp."""
    try:
        v = cast(raw)
    except (TypeError, ValueError):
        return default
    if lo is not None:
        v = max(lo, v)
    if hi is not None:
        v = min(hi, v)
    return v


def _sse(payload: dict) -> str:
    return f"data: {json.dumps(payload, ensure_ascii=False)}\n\n"


def _clean_name(name: str) -> str:
    return re.sub(r"[^A-Za-z0-9._-]+", "_", Path(name or "recording.wav").name) or "recording.wav"


def _stats(events, scores, labels, duration: float) -> dict:
    counts: dict[str, int] = {}
    seconds: dict[str, float] = {}
    for ev in events:
        key = ev.label.replace(" (?)", "")
        counts[key] = counts.get(key, 0) + 1
        seconds[key] = seconds.get(key, 0.0) + ev.duration

    speech_sec = 0.0
    if len(scores) and "Speech" in labels:
        idx = labels.index("Speech")
        speech_sec = float((scores[:, idx] > E.SPEECH_THRESHOLD).sum()) * E.YAMNET_HOP_SEC

    active = float(sum(ev.duration for ev in events))
    ranked = sorted(counts.items(), key=lambda kv: -kv[1])
    top_label = ranked[0][0] if ranked else None

    sentence = None
    if events:
        best = max(events, key=lambda e: e.score)
        sentence = (
            f"Over {duration:.0f} s the microphone picked up {len(events)} distinct sound "
            f"events; the commonest was \"{top_label}\" ({counts[top_label]} times), and the "
            f"most confident single detection is \"{best.label.replace(' (?)', '')}\" at "
            f"{E._mmss(best.start)}."
        )

    return {
        "n_events": len(events),
        "active_s": round(active, 2),
        "active_pct": round(100.0 * active / duration, 1) if duration else 0.0,
        "quiet_s": round(duration - active, 2),
        "speech_s": round(speech_sec, 2),
        "speech_pct": round(100.0 * speech_sec / duration, 1) if duration else 0.0,
        "counts": [{"label": k, "n": v, "seconds": round(seconds[k], 1)} for k, v in ranked],
        "sentence": sentence,
    }


# --------------------------------------------------------------------------- #
# the pipeline, streamed as server-sent events
# --------------------------------------------------------------------------- #

def _analyse(src: Path, run_dir: Path, rid: str, p: dict):
    """Yield stage updates, then one final ``result`` payload."""

    # ---- 1. load & clean -------------------------------------------------- #
    yield _sse({"type": "stage", "n": 1, "label": "Load & clean",
                "detail": f"decoding {src.name}"})
    window = p["duration"] if p["duration"] and p["duration"] > 0 else None
    audio = E.load_and_clean(src, E.TARGET_SR, window)
    duration = len(audio) / E.TARGET_SR
    peak = float(np.max(np.abs(audio))) if len(audio) else 0.0
    rms = float(np.sqrt(np.mean(np.square(audio, dtype=np.float64)))) if len(audio) else 0.0
    yield _sse({"type": "stage", "n": 1, "status": "done",
                "detail": f"{duration:.1f}s @ {E.TARGET_SR} Hz mono, "
                          f"peak {20*np.log10(peak+1e-12):.1f} dB"})

    # ---- 2. detect (hand-written engine, unchanged from v1) --------------- #
    yield _sse({"type": "stage", "n": 2, "label": "Detect start/stop",
                "detail": "energy over time"})
    events, dbg = E.detect_events(
        audio, E.TARGET_SR,
        min_duration=p["min_duration"], merge_gap=p["merge_gap"],
        on_margin=p["on_margin"], off_margin=p["off_margin"],
        attack_sec=p["attack"], release_sec=p["release"],
    )
    yield _sse({"type": "stage", "n": 2, "status": "done",
                "detail": f"{len(events)} events found"})

    # ---- 3. label with YAMNet --------------------------------------------- #
    scores = np.zeros((0, 521), dtype=np.float32)
    centers = np.zeros(0)
    labels: list[str] = []
    if p["skip_model"] or not events:
        yield _sse({"type": "stage", "n": 3, "label": "Label with YAMNet",
                    "status": "skipped",
                    "detail": "model skipped" if p["skip_model"] else "nothing to label"})
    else:
        yield _sse({"type": "stage", "n": 3, "label": "Label with YAMNet",
                    "detail": "loading model on first run..."})
        model = labeller()
        with _LIVE_LOCK:
            scores, centers = model.scores(audio, E.TARGET_SR)
        labels = model.labels
        events = E.label_events(events, scores, centers, labels)
        yield _sse({"type": "stage", "n": 3, "status": "done",
                    "detail": f"{len(scores)} windows analysed"})

    # ---- 4. report --------------------------------------------------------- #
    yield _sse({"type": "stage", "n": 4, "label": "Report", "detail": "drawing spectrogram"})
    png = run_dir / "spectrogram.png"
    E.plot_spectrogram(audio, events, E.TARGET_SR, png, src.name, dbg)

    with contextlib.redirect_stdout(io.StringIO()) as buf:
        table = E.print_table(events, duration)
    (run_dir / "events.txt").write_text(table, encoding="utf-8")

    with contextlib.redirect_stdout(io.StringIO()):
        E.save_csv(events, run_dir / "events.csv", duration)

    stats = _stats(events, scores, labels, duration)
    if labels:
        with contextlib.redirect_stdout(io.StringIO()) as sbuf:
            text = E.statistics(events, scores, centers, labels, duration)
        (run_dir / "summary.txt").write_text(table + "\n" + text + "\n", encoding="utf-8")
    else:
        (run_dir / "summary.txt").write_text(table + "\n", encoding="utf-8")

    audio_out = run_dir / _clean_name(src.name)
    if audio_out != src:                     # the upload already lives in run_dir
        shutil.copyfile(src, audio_out)

    yield _sse({"type": "stage", "n": 4, "status": "done", "detail": "ready"})

    payload = {
        "type": "result",
        "id": rid,
        "file": _clean_name(src.name),
        "duration": round(duration, 2),
        "sample_rate": E.TARGET_SR,
        "peak_db": round(20 * np.log10(peak + 1e-12), 1),
        "rms_db": round(20 * np.log10(rms + 1e-12), 1),
        "skipped_model": bool(p["skip_model"] or not events),
        "params": p,
        "stats": stats,
        "events": [
            {
                "i": ev.index,
                "start": ev.start,
                "end": ev.end,
                "dur": round(ev.duration, 3),
                "label": ev.label,
                "plain": ev.label.replace(" (?)", ""),
                "flagged": "(?)" in ev.label,
                "score": round(ev.score, 4),
                "candidates": [{"label": n, "score": round(s, 4)} for n, s in ev.candidates],
            }
            for ev in events
        ],
        "urls": {
            "image": f"/results/{rid}/spectrogram.png",
            "csv": f"/results/{rid}/events.csv",
            "table": f"/results/{rid}/events.txt",
            "summary": f"/results/{rid}/summary.txt",
            "audio": f"/results/{rid}/{_clean_name(src.name)}",
        },
    }
    yield _sse(payload)


# --------------------------------------------------------------------------- #
# routes
# --------------------------------------------------------------------------- #

@app.get("/")
def index():
    return FileResponse(STATIC / "index.html")


@app.get("/api/config")
def config():
    """Engine defaults, read from the engine itself."""
    return {
        "target_sr": E.TARGET_SR,
        "min_duration": E.DEFAULT_MIN_DURATION,
        "merge_gap": E.DEFAULT_MERGE_GAP,
        "on_margin": E.ON_MARGIN_DB,
        "off_margin": E.OFF_MARGIN_DB,
        "attack": E.DEFAULT_ATTACK_SEC,
        "release": E.DEFAULT_RELEASE_SEC,
        "duration": 0.0,          # 0 = analyse the whole recording
        "task_min": 120,
        "task_max": 180,
        "non_event_labels": sorted(E.NON_EVENT_LABELS),
        "confidence": E.MIN_CONFIDENCE,
    }


@app.post("/api/live")
def live(file: UploadFile = File(...)):
    """Label whatever the microphone is hearing *right now*.

    The recorder posts the last ~1.8 s of audio every 1.2 s while it is
    capturing, so the live popup can name the sound with the same 521-class
    YAMNet model the full analysis uses — "Whistling", "Bark", "Speech" …

    Returns the top few classes ranked by their best window score (max, not
    mean, so a short bark inside a longer chunk still wins).
    """
    raw = file.file.read()
    if len(raw) < 2000:
        raise HTTPException(400, "chunk too small")

    tmp = Path(tempfile.gettempdir()) / f"whh_live_{uuid.uuid4().hex}.wav"
    try:
        tmp.write_bytes(raw)
        import soundfile as sf
        data, sr = sf.read(str(tmp), dtype="float32", always_2d=True)
    except Exception as exc:
        raise HTTPException(400, f"could not decode chunk: {exc}")
    finally:
        tmp.unlink(missing_ok=True)

    mono = data.mean(axis=1)
    duration = len(mono) / float(sr or E.TARGET_SR)
    rms = float(np.sqrt(np.mean(np.square(mono, dtype=np.float64)))) if len(mono) else 0.0
    rms_db = round(20 * float(np.log10(rms + 1e-12)), 1)

    # Too quiet to mean anything — do not amplify the noise floor into a label.
    if rms_db < -50.0:
        return {"top": [], "windows": 0, "quiet": True,
                "duration": round(duration, 2), "rms_db": rms_db}

    mono = E.normalize(E.resample(mono, sr, E.TARGET_SR))
    model = labeller()
    with _LIVE_LOCK:
        scores, _ = model.scores(mono, E.TARGET_SR)
    scores = np.asarray(scores, dtype=np.float32)
    if not len(scores):
        return {"top": [], "windows": 0, "quiet": True,
                "duration": round(duration, 2), "rms_db": rms_db}

    peak = scores.max(axis=0)                 # best window: catches short sounds
    mean = scores.mean(axis=0)
    blocked = [i for i, name in enumerate(model.labels) if name in E.NON_EVENT_LABELS]
    raw_best = int(np.argmax(peak))
    ranked = peak.copy()
    ranked[blocked] = -1.0                    # Silence/Noise/Static never win
    order = np.argsort(ranked)[::-1][:4]

    return {
        "top": [{"label": model.labels[i], "score": round(float(peak[i]), 3),
                 "mean": round(float(mean[i]), 3)}
                for i in order if ranked[i] > 0.02],
        "windows": int(len(scores)),
        "quiet": False,
        "blocked_hit": bool(raw_best in blocked),   # model heard only silence/noise
        "duration": round(duration, 2),
        "rms_db": rms_db,
    }


@app.post("/api/analyse")
async def analyse(
    file: UploadFile = File(...),
    min_duration: str = Form(None),
    merge_gap: str = Form(None),
    on_margin: str = Form(None),
    off_margin: str = Form(None),
    attack: str = Form(None),
    release: str = Form(None),
    duration: str = Form(None),
    skip_model: str = Form("0"),
):
    name = _clean_name(file.filename or "recording.wav")
    if not name.lower().endswith((".wav", ".mp3", ".ogg", ".flac", ".m4a", ".opus", ".webm", ".aac")):
        raise HTTPException(400, f"unsupported audio type: {file.filename}")

    rid = uuid.uuid4().hex[:12]
    run_dir = RESULTS / rid
    run_dir.mkdir(parents=True, exist_ok=True)
    src = run_dir / name
    with open(src, "wb") as fh:
        shutil.copyfileobj(file.file, fh)

    params = {
        "min_duration": _num(min_duration, E.DEFAULT_MIN_DURATION, lo=0.0, hi=10.0),
        "merge_gap": _num(merge_gap, E.DEFAULT_MERGE_GAP, lo=0.0, hi=30.0),
        "on_margin": _num(on_margin, E.ON_MARGIN_DB, lo=0.0, hi=60.0),
        "off_margin": _num(off_margin, E.OFF_MARGIN_DB, lo=0.0, hi=60.0),
        "attack": _num(attack, E.DEFAULT_ATTACK_SEC, lo=0.0, hi=10.0),
        "release": _num(release, E.DEFAULT_RELEASE_SEC, lo=0.0, hi=10.0),
        "duration": _num(duration, 0.0, lo=0.0, hi=3600.0),
        "skip_model": str(skip_model) in ("1", "true", "on", "yes"),
    }

    def gen():
        try:
            yield from _analyse(src, run_dir, rid, params)
        except Exception as exc:                       # never leave the UI hanging
            import traceback
            traceback.print_exc()
            yield _sse({"type": "error", "message": f"{type(exc).__name__}: {exc}"})

    return StreamingResponse(gen(), media_type="text/event-stream",
                             headers={"Cache-Control": "no-cache",
                                      "X-Accel-Buffering": "no"})


@app.get("/results/{rid}/{fname}")
def result_file(rid: str, fname: str):
    if not re.fullmatch(r"[0-9a-f]{12}", rid) or "/" in fname or "\\" in fname:
        raise HTTPException(404)
    path = RESULTS / rid / fname
    if not path.is_file():
        raise HTTPException(404)
    return FileResponse(path)


app.mount("/static", StaticFiles(directory=STATIC), name="static")


if __name__ == "__main__":
    import sys

    import uvicorn
    # PORT/HOST let a cloud host configure the listener; defaults keep the
    # local behaviour (python server.py [port] on 127.0.0.1) unchanged.
    port = int(os.environ.get("PORT") or (sys.argv[1] if len(sys.argv) > 1 else 8000))
    host = os.environ.get("HOST", "127.0.0.1")
    uvicorn.run(app, host=host, port=port, log_level="warning")

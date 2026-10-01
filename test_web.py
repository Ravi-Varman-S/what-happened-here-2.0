"""Smoke test for the 2.0 web API (run with the server already listening)."""
import json
import sys
from pathlib import Path

import httpx

BASE = "http://127.0.0.1:8000"
HERE = Path(__file__).resolve().parent


def sample(name: str) -> str:
    """Use the clip shipped with this repo, else fall back to the v1 checkout."""
    local = HERE / "audio" / name
    return str(local if local.exists() else Path(r"C:\what-happened-here\audio") / name)


AUDIO = sample("street_3min.wav")
KITCHEN = sample("kitchen_3min.wav")

ok = True


def check(name, cond, extra=""):
    global ok
    ok = ok and bool(cond)
    print(f"  [{'PASS' if cond else 'FAIL'}] {name}{(' - ' + str(extra)) if extra else ''}")


print("1. static + config")
html = httpx.get(BASE + "/", timeout=10).text
check("GET / serves the app", "What Happened Here? 2.0" in html and "dropzone" in html)
cfg = httpx.get(BASE + "/api/config", timeout=10).json()
check("GET /api/config", cfg.get("on_margin") == 6.0 and cfg.get("attack") == 0.1, cfg)

print("2. POST /api/analyse (street clip, full pipeline)")
stages, result = [], None
with httpx.Client(timeout=600) as c:
    with c.stream("POST", BASE + "/api/analyse",
                  files={"file": ("street_3min.wav", open(AUDIO, "rb"), "audio/wav")},
                  data={"on_margin": "6", "off_margin": "4"}) as r:
        check("status 200", r.status_code == 200, r.status_code)
        check("content-type", "text/event-stream" in r.headers.get("content-type", ""))
        for line in r.iter_lines():
            if line.startswith("data: "):
                p = json.loads(line[6:])
                if p.get("type") == "stage":
                    stages.append((p["n"], p.get("status", "active"), p.get("detail", "")))
                elif p.get("type") == "error":
                    check("no error event", False, p.get("message"))
                elif p.get("type") == "result":
                    result = p

check("all 4 stages streamed", len({n for n, *_ in stages}) == 4, stages)
for n, status, detail in stages:
    if status in ("done", "skipped"):
        print(f"      step {n} {status:6} {detail}")

check("result payload", result is not None)
if result:
    ev, st = result["events"], result["stats"]
    check("events found", len(ev) > 0, f"{len(ev)} events")
    check("stats match events", st["n_events"] == len(ev))
    check("labels present", all(e["label"] for e in ev[:5]), ev[0]["plain"] if ev else "")
    check("speech coverage computed", "speech_pct" in st, st["speech_pct"])
    print(f"      {len(ev)} events | {st['active_pct']}% active | "
          f"{st['speech_pct']}% speech | top: "
          + ", ".join(f"{c['label']}x{c['n']}" for c in st["counts"][:4]))

    print("3. generated files")
    for key, expect in [("image", "png"), ("csv", "csv"), ("table", "txt"),
                        ("summary", "txt"), ("audio", "wav")]:
        resp = httpx.get(BASE + result["urls"][key], timeout=60)
        check(f"GET {result['urls'][key]}", resp.status_code == 200 and len(resp.content) > 100,
              f"{resp.status_code}, {len(resp.content)} bytes")
    csv_text = httpx.get(BASE + result["urls"]["csv"]).text
    check("csv has header", "start_s" in csv_text.splitlines()[0], csv_text.splitlines()[0])
    check("csv rows == events", len(csv_text.strip().splitlines()) == len(ev) + 1)

    print("4. fast path (--skip-model)")
    with httpx.Client(timeout=300) as c:
        with c.stream("POST", BASE + "/api/analyse",
                      files={"file": ("kitchen.wav", open(KITCHEN, "rb"), "audio/wav")},
                      data={"skip_model": "1"}) as r:
            fast = None
            for line in r.iter_lines():
                if line.startswith("data: "):
                    p = json.loads(line[6:])
                    if p.get("type") == "result":
                        fast = p
    check("skip_model result", fast is not None and fast["skipped_model"] is True)
    if fast:
        check("detection still ran", len(fast["events"]) > 0, f"{len(fast['events'])} events")

print("5. live labelling (/api/live)")
import io as _io

import numpy as _np
import soundfile as _sf

# a 2.5 s slice of the street clip (24.0–26.5 s is the "Vehicle" stretch)
_data, _sr = _sf.read(AUDIO, dtype="float32", always_2d=True)
_seg = _data[int(24.0 * _sr):int(26.5 * _sr)]
_buf = _io.BytesIO()
_sf.write(_buf, _seg, _sr, format="WAV")
_buf.seek(0)
live = httpx.post(BASE + "/api/live", files={"file": ("chunk.wav", _buf, "audio/wav")},
                  timeout=300)
check("POST /api/live", live.status_code == 200, live.status_code)
_top = live.json().get("top", []) if live.status_code == 200 else []
check("top classes returned", len(_top) > 0, _top[:2])
check("scores are probabilities", all(0.0 <= c["score"] <= 1.0 for c in _top), _top[:1])

_hush = _io.BytesIO()
_sf.write(_hush, _np.zeros(int(2 * 16000), dtype="float32"), 16000, format="WAV")
_hush.seek(0)
quiet = httpx.post(BASE + "/api/live", files={"file": ("hush.wav", _hush, "audio/wav")},
                   timeout=60)
check("silence is not labelled", quiet.status_code == 200 and quiet.json().get("quiet") is True,
      quiet.json() if quiet.status_code == 200 else quiet.status_code)

print("6. rejection of nonsense uploads")
bad = httpx.post(BASE + "/api/analyse", files={"file": ("x.exe", b"MZ", "application/x")}, timeout=30)
check("non-audio rejected", bad.status_code == 400, bad.status_code)

print("\n" + ("ALL PASSED" if ok else "SOME CHECKS FAILED"))
sys.exit(0 if ok else 1)

from __future__ import annotations

import argparse
import csv
import os
import sys
import warnings
from dataclasses import dataclass, field
from pathlib import Path

# Keep TensorFlow quiet *before* it is imported.
os.environ.setdefault("TF_CPP_MIN_LOG_LEVEL", "3")
warnings.filterwarnings("ignore")

import numpy as np

# --------------------------------------------------------------------------- #
# Configuration
# --------------------------------------------------------------------------- #

TARGET_SR = 16_000        # YAMNet's native sample rate
TARGET_RMS_DB = -26.0     # loudness we normalise the file to
PEAK_CEIL = 0.99          # never normalise past this peak

# Frame / hop used for the energy curve (seconds)
FRAME_SEC = 0.025
HOP_SEC = 0.010

# Event detector defaults (seconds / dB)
DEFAULT_MIN_DURATION = 0.10   # ignore blips shorter than this
DEFAULT_MERGE_GAP = 0.40      # glue events separated by less than this
DEFAULT_ATTACK_SEC = 0.10     # must stay loud this long before an event opens
DEFAULT_RELEASE_SEC = 0.10     # must stay quiet this long before it closes

# Classes that contradict the detector: it only fires where sound *is*
# present, so "Silence" can never be the right answer for a detected event.
NON_EVENT_LABELS = {"Silence", "Noise", "Static"}
DEFAULT_SMOOTH_SEC = 0.06     # moving-average smoothing of the dB curve
BASELINE_SEC = 5.0            # window of the rolling background estimate
BASELINE_PCT = 25.0           # percentile used as the ambient noise floor
ON_MARGIN_DB = 6.0            # dB above baseline that starts an event
OFF_MARGIN_DB = 4.0           # dB above baseline that ends it

MIN_SEGMENT_SEC = 0.96        # YAMNet analysis window length
YAMNET_HOP_SEC = 0.48         # YAMNet analysis hop
MIN_CONFIDENCE = 0.20         # below this we call a segment "unlabelled"

SPEECH_THRESHOLD = 0.30       # frame score counted as speech


# --------------------------------------------------------------------------- #
# Data structures
# --------------------------------------------------------------------------- #

@dataclass
class Event:
    """One detected sound event."""
    index: int
    start: float
    end: float
    label: str = "—"
    score: float = 0.0
    candidates: list = field(default_factory=list)

    @property
    def duration(self) -> float:
        return self.end - self.start


# --------------------------------------------------------------------------- #
# 1. Load and clean the audio
# --------------------------------------------------------------------------- #

def decode_to_array(path: Path, target_sr: int) -> tuple[np.ndarray, int]:
    """Read *path* into a float32 mono array sampled at ``target_sr``.

    ``soundfile`` handles WAV/FLAC/OGG-Vorbis.  Anything it cannot decode
    (Speex/Opus OGG, MP3, ...) falls back to an ffmpeg transcode.
    """
    import soundfile as sf

    try:
        data, sr = sf.read(str(path), dtype="float32", always_2d=True)
    except Exception:
        data, sr = _ffmpeg_decode(path, target_sr)

    # Stereo -> mono (average of channels)
    mono = data.mean(axis=1)
    return mono, sr


def _ffmpeg_decode(path: Path, target_sr: int) -> tuple[np.ndarray, int]:
    """Decode exotic containers with the ffmpeg binary bundled by imageio-ffmpeg."""
    import imageio_ffmpeg
    import soundfile as sf
    import subprocess
    import tempfile

    ffmpeg = imageio_ffmpeg.get_ffmpeg_exe()
    with tempfile.TemporaryDirectory() as tmp:
        out = Path(tmp) / "decoded.wav"
        cmd = [
            ffmpeg, "-y", "-hide_banner", "-loglevel", "error",
            "-i", str(path),
            "-ac", "1", "-ar", str(target_sr),
            "-c:a", "pcm_s16le", str(out),
        ]
        subprocess.run(cmd, check=True, capture_output=True)
        data, sr = sf.read(str(out), dtype="float32", always_2d=True)
    return data, sr


def resample(mono: np.ndarray, sr: int, target_sr: int) -> np.ndarray:
    """High-quality resample (soxr kernel) or pass-through when already matched."""
    if sr == target_sr:
        return mono.astype(np.float32, copy=False)
    import librosa
    return librosa.resample(mono, orig_sr=sr, target_sr=target_sr).astype(np.float32)


def normalize(mono: np.ndarray, target_db: float = TARGET_RMS_DB) -> np.ndarray:
    """RMS-normalise to *target_db* with a peak ceiling so nothing clips."""
    rms = float(np.sqrt(np.mean(np.square(mono), dtype=np.float64)))
    if rms <= 1e-12:
        return mono
    gain = 10.0 ** (target_db / 20.0) / rms
    peak = float(np.max(np.abs(mono))) * gain
    if peak > PEAK_CEIL:
        gain *= PEAK_CEIL / peak
    return (mono * gain).astype(np.float32)


def load_and_clean(path: Path,
                   target_sr: int = TARGET_SR,
                   duration: float | None = None) -> np.ndarray:
    """Step 1: decode, mono, resample, normalise (and optionally trim)."""
    mono, sr = decode_to_array(path, target_sr)
    mono = resample(mono, sr, target_sr)

    if duration is not None:
        n = int(round(duration * target_sr))
        if len(mono) >= n:
            mono = mono[:n]
        else:                                    # pad with silence if too short
            mono = np.pad(mono, (0, n - len(mono)))

    return normalize(mono)


# --------------------------------------------------------------------------- #
# 2. Detect when events start and stop  -- written by hand
# --------------------------------------------------------------------------- #

def energy_curve(mono: np.ndarray,
                 sr: int,
                 frame_sec: float = FRAME_SEC,
                 hop_sec: float = HOP_SEC) -> tuple[np.ndarray, np.ndarray]:
    """Loudness of the signal over time.

    The signal is cut into overlapping frames; each frame's RMS is converted
    to decibels.  Returns ``(times, db)`` where *times* are frame centres.
    """
    frame = max(1, int(round(frame_sec * sr)))
    hop = max(1, int(round(hop_sec * sr)))

    if len(mono) < frame:
        mono = np.pad(mono, (0, frame - len(mono)))

    # Stride-trick framing: shape (n_frames, frame)
    n_frames = 1 + (len(mono) - frame) // hop
    idx = np.arange(frame)[None, :] + hop * np.arange(n_frames)[:, None]
    frames = mono[idx]

    rms = np.sqrt(np.mean(np.square(frames, dtype=np.float64), axis=1))
    db = 20.0 * np.log10(rms + 1e-10)

    times = (np.arange(n_frames) * hop + frame / 2) / sr
    return times, db


def _moving_average(x: np.ndarray, n: int) -> np.ndarray:
    """Simple centred moving average (odd *n*)."""
    if n <= 1:
        return x
    if n % 2 == 0:
        n += 1
    kernel = np.ones(n) / n
    pad = n // 2
    padded = np.pad(x, pad, mode="edge")
    return np.convolve(padded, kernel, mode="valid")


def _rolling_percentile(x: np.ndarray, window: int, pct: float) -> np.ndarray:
    """Rolling percentile used as a robust estimate of the local noise floor.

    A low percentile (rather than the median) deliberately ignores the loud
    parts of the signal, so an event that stays loud for several seconds is
    still measured against the *ambient* level of that neighbourhood.

    The first and last ``window // 2`` frames cannot have a full window, so
    they use a partial one instead of padding with the end value — otherwise
    a silent first frame would drag the baseline of the whole opening
    seconds down to digital silence.
    """
    if window <= 1:
        return x.copy()
    if window % 2 == 0:
        window += 1
    pad = window // 2

    from scipy.ndimage import percentile_filter
    out = percentile_filter(x, percentile=pct, size=window, mode="nearest")

    for i in range(min(pad, len(x))):                 # opening: partial window
        out[i] = np.percentile(x[: i + pad + 1], pct)
    for i in range(max(0, len(x) - pad), len(x)):     # closing: partial window
        out[i] = np.percentile(x[max(0, i - pad):], pct)
    return out


def adaptive_thresholds(db: np.ndarray,
                        on_margin: float = ON_MARGIN_DB,
                        off_margin: float = OFF_MARGIN_DB,
                        window_sec: float = BASELINE_SEC,
                        pct: float = BASELINE_PCT) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    """Hysteresis thresholds that follow a slowly-changing background level.

    A rolling low-percentile gives the ambient noise floor; an event is "on"
    once the loudness rises ``on_margin`` dB above it and "off" again once it
    falls back under ``off_margin`` dB.  Using two levels (hysteresis) stops a
    noisy event from flickering in and out.
    """
    window = int(round(window_sec / HOP_SEC))
    baseline = _rolling_percentile(db, window, pct)
    return baseline + on_margin, baseline + off_margin, baseline


def detect_events(mono: np.ndarray,
                  sr: int,
                  min_duration: float = DEFAULT_MIN_DURATION,
                  merge_gap: float = DEFAULT_MERGE_GAP,
                  smooth_sec: float = DEFAULT_SMOOTH_SEC,
                  on_margin: float = ON_MARGIN_DB,
                  off_margin: float = OFF_MARGIN_DB,
                  attack_sec: float = DEFAULT_ATTACK_SEC,
                  release_sec: float = DEFAULT_RELEASE_SEC) -> tuple[list[Event], dict]:
    """Step 2: find where sound events start and stop.

    The state machine is deliberately debounced in both directions: the level
    must stay **above** the start threshold for ``attack_sec`` before an event
    opens, and stay **below** the stop threshold for ``release_sec`` before it
    closes.  Without this, ordinary jitter on a smooth background would flicker
    the state open and closed many times a second and manufacture dozens of
    phantom events (each of which YAMNet would then honestly label "Silence").

    Returns ``(events, debug)`` where *debug* carries the energy curve for
    plotting.
    """
    times, db = energy_curve(mono, sr)
    smooth = _moving_average(db, int(round(smooth_sec / HOP_SEC)))

    on_thr, off_thr, baseline = adaptive_thresholds(smooth, on_margin, off_margin)

    attack = max(1, int(round(attack_sec / HOP_SEC)))
    release = max(1, int(round(release_sec / HOP_SEC)))

    # ---- debounced state machine ----------------------------------------- #
    segments: list[list[float]] = []
    active = False
    start_t = 0.0
    end_t = 0.0
    above = 0          # consecutive frames above the start threshold
    below = 0          # consecutive frames below the stop threshold

    for t, v, hi, lo in zip(times, smooth, on_thr, off_thr):
        if not active:
            if v > hi:
                if above == 0:
                    start_t = t          # remember the very first loud frame
                above += 1
                if above >= attack:      # sustained -> open the event
                    active = True
                    below = 0
            else:
                above = 0                 # flicker -> cancel, never opened
        else:
            if v < lo:
                if below == 0:
                    end_t = t            # remember the first quiet frame
                below += 1
                if below >= release:      # sustained -> close the event
                    active = False
                    segments.append([start_t, end_t])
            else:
                below = 0
    if active:
        segments.append([start_t, float(times[-1])])

    # ---- clean-up: merge close segments, drop micro blips ----------------- #
    merged: list[list[float]] = []
    for seg in segments:
        if merged and seg[0] - merged[-1][1] <= merge_gap:
            merged[-1][1] = seg[1]
        else:
            merged.append(seg[:])

    kept = [s for s in merged if (s[1] - s[0]) >= min_duration]

    events = [Event(index=i + 1, start=round(float(s[0]), 3), end=round(float(s[1]), 3))
              for i, s in enumerate(kept)]

    debug = dict(times=times, db=smooth, on=on_thr, off=off_thr, baseline=baseline)
    return events, debug


# --------------------------------------------------------------------------- #
# 3. Label each event with YAMNet
# --------------------------------------------------------------------------- #

class YamnetLabeller:
    """Wraps the pretrained YAMNet model from TensorFlow Hub."""

    def __init__(self):
        import pandas as pd
        import tensorflow_hub as hub

        self.model = hub.load("https://tfhub.dev/google/yamnet/1")

        # The class map is bundled as an asset of the SavedModel itself,
        # so no extra network request is needed to name the 521 classes.
        asset = self.model.class_map_path().numpy().decode()
        self.labels = pd.read_csv(asset)["display_name"].tolist()

    def scores(self, mono: np.ndarray, sr: int = TARGET_SR) -> tuple[np.ndarray, np.ndarray]:
        """Run YAMNet over the whole recording.

        Returns ``(scores, frame_times)``; one row of 521 probabilities every
        0.48 s, with *frame_times* marking the centre of each analysis window.
        """
        scores, _, _ = self.model(mono.astype(np.float32))
        scores = np.asarray(scores, dtype=np.float32)
        starts = np.arange(len(scores)) * YAMNET_HOP_SEC
        centers = starts + MIN_SEGMENT_SEC / 2.0
        return scores, centers

    @staticmethod
    def top_k(scores: np.ndarray, labels: list[str], k: int = 3):
        """Best *k* (label, probability) pairs, sorted by score."""
        order = np.argsort(scores)[::-1][:k]
        return [(labels[i], float(scores[i])) for i in order]


def label_events(events: list[Event],
                 scores: np.ndarray,
                 centers: np.ndarray,
                 labels: list[str]) -> list[Event]:
    """Attach the most likely YAMNet class to every detected event.

    Classes that would contradict the detector (``Silence``, ``Noise``…) are
    ruled out before ranking: step 2 only opens an event where the loudness is
    several dB *above* the local background, so silence cannot be the answer.
    Whatever wins is therefore the best explanation of sound that we already
    know is there.
    """
    if len(events) == 0 or len(scores) == 0:
        return events

    # Resolve the blocked class indices once, not per event.
    blocked = np.array([i for i, name in enumerate(labels)
                        if name in NON_EVENT_LABELS], dtype=int)

    for ev in events:
        mask = (centers >= ev.start) & (centers <= ev.end)
        if not mask.any():                       # very short event -> nearest frame
            nearest = int(np.argmin(np.abs(centers - (ev.start + ev.end) / 2)))
            mask = np.zeros(len(centers), dtype=bool)
            mask[nearest] = True

        mean_score = scores[mask].mean(axis=0)
        raw_best = int(np.argmax(mean_score))
        blocked_hit = raw_best in blocked           # model heard nothing nameable

        ranked = mean_score.copy()
        ranked[blocked] = -1.0                      # silence can never win
        best = YamnetLabeller.top_k(ranked, labels, k=3)

        ev.candidates = best
        ev.label, ev.score = best[0]
        # Flag low confidence, and also flag a swapped-in answer: the model's
        # own favourite was "Silence", so it did not really recognise a sound.
        if ev.score < MIN_CONFIDENCE or blocked_hit:
            ev.label = f"{ev.label} (?)"
    return events


# --------------------------------------------------------------------------- #
# 4. Reporting: spectrogram, table, statistics
# --------------------------------------------------------------------------- #

def plot_spectrogram(mono: np.ndarray,
                     events: list[Event],
                     sr: int,
                     out_path: Path,
                     title: str,
                     debug: dict | None = None) -> None:
    """Spectrogram with the detected events shaded and labelled.

    The lower panel shows the hand-computed loudness curve together with the
    adaptive background estimate and the two hysteresis thresholds, so it is
    obvious *why* each event was cut where it was.
    """
    import matplotlib
    matplotlib.use("Agg")
    import matplotlib.pyplot as plt
    import librosa

    n_fft = 2048
    hop = 512
    S = librosa.feature.melspectrogram(y=mono, sr=sr, n_fft=n_fft,
                                       hop_length=hop, n_mels=128)
    S_db = librosa.power_to_db(S, ref=np.max)

    duration = len(mono) / sr
    two_panel = debug is not None
    fig, axes = plt.subplots(2 if two_panel else 1, 1,
                             figsize=(16, 9 if two_panel else 6),
                             sharex=True,
                             gridspec_kw={"height_ratios": [3, 1]} if two_panel else None)
    ax = axes[0] if two_panel else axes

    img = librosa.display.specshow(S_db, sr=sr, hop_length=hop, x_axis="time",
                                   y_axis="mel", ax=ax, cmap="magma")
    fig.colorbar(img, ax=ax, format="%+2.0f dB").set_label("Intensity (dB)")
    ax.set_ylim(0, min(8000, sr / 2))

    colours = plt.cm.tab20(np.linspace(0, 1, 20))
    top = ax.get_ylim()[1]
    n_rows = 6
    font = 6.8
    row_y = [top * (0.97 - 0.085 * r) for r in range(n_rows)]
    row_edge = [-1e9] * n_rows            # right edge (seconds) per row

    fig_w = fig.get_size_inches()[0]
    sec_per_in = duration / fig_w

    # Greedy row assignment so labels never overlap each other.
    for ev in sorted(events, key=lambda e: e.start):
        c = colours[(ev.index - 1) % len(colours)]
        ax.axvspan(ev.start, ev.end, color=c, alpha=0.30, linewidth=0)
        ax.axvline(ev.start, color=c, lw=1.0, alpha=0.9)
        ax.axvline(ev.end, color=c, lw=1.0, alpha=0.9)

        label = ev.label.replace(" (?)", "")
        if len(label) > 16:
            label = label[:15] + "…"
        text = f"{ev.index}. {label}"

        width_in = font * 0.58 * len(text) / 72.0
        width_s = width_in * sec_per_in
        centre = (ev.start + ev.end) / 2
        left = centre - width_s / 2

        for r in range(n_rows):
            if left > row_edge[r]:
                ax.text(centre, row_y[r], text, color="white", fontsize=font,
                        ha="center", va="top",
                        bbox=dict(boxstyle="round,pad=0.22", fc="black",
                                  alpha=0.72, lw=0))
                row_edge[r] = left + width_s
                break

    ax.set_title(f"{title} — spectrogram with {len(events)} detected events "
                 f"(shaded bands = detected events, table lists them all)")
    ax.set_ylabel("Frequency (Hz)")

    if two_panel:
        ax2 = axes[1]
        ax2.plot(debug["times"], debug["db"], color="0.4", lw=0.8,
                 label="Loudness (RMS dB, 10 ms frames)")
        ax2.plot(debug["times"], debug["baseline"], color="tab:blue", lw=1.4,
                 label="Ambient floor (rolling 25th percentile, 5 s)")
        ax2.plot(debug["times"], debug["on"], color="tab:green", lw=1.1,
                 ls="--", label="Start threshold (+6 dB)")
        ax2.plot(debug["times"], debug["off"], color="tab:red", lw=1.1,
                 ls=":", label="Stop threshold (+4 dB)")
        for ev in events:
            ax2.axvspan(ev.start, ev.end, color="gold", alpha=0.45, linewidth=0)
        ax2.set_ylabel("Loudness (dB)")
        ax2.set_xlabel("Time (s)")
        ax2.legend(loc="upper right", fontsize=7, ncol=2)
        ax2.grid(alpha=0.25)

    ax.set_xlim(0, duration)
    fig.tight_layout()
    fig.savefig(out_path, dpi=130)
    plt.close(fig)


def print_table(events: list[Event], duration: float) -> str:
    """Render the timing table as a fixed-width string."""
    header = f"{'#':>3}  {'Start':>8}  {'End':>8}  {'Dur':>7}  {'Event':<38} {'Conf':>5}"
    line = "-" * len(header)
    rows = [line, header, line]
    for ev in events:
        rows.append(
            f"{ev.index:>3}  {_mmss(ev.start):>8}  {_mmss(ev.end):>8}  "
            f"{ev.duration:>6.2f}s  {ev.label:<38} {ev.score:>5.0%}"
        )
    rows.append(line)
    rows.append(f"{len(events)} events in {_mmss(duration)} of audio")
    table = "\n".join(rows)
    print(table)
    return table


def _mmss(seconds: float) -> str:
    m, s = divmod(seconds, 60)
    return f"{int(m):02d}:{s:05.2f}"


def save_csv(events: list[Event], out_path: Path, duration: float) -> None:
    with open(out_path, "w", newline="", encoding="utf-8") as fh:
        w = csv.writer(fh)
        w.writerow(["event", "start_s", "end_s", "duration_s", "label",
                    "confidence", "runner_up_1", "runner_up_2"])
        for ev in events:
            alts = [f"{n}:{s:.2f}" for n, s in ev.candidates[1:3]]
            w.writerow([ev.index, f"{ev.start:.3f}", f"{ev.end:.3f}",
                        f"{ev.duration:.3f}", ev.label, f"{ev.score:.4f}",
                        *alts])
    print(f"\nCSV written : {out_path}")


def statistics(events: list[Event],
               scores: np.ndarray,
               centers: np.ndarray,
               labels: list[str],
               duration: float) -> str:
    """Optional bonus: count things worth knowing about the recording."""
    lines = ["", "=" * 66, "WHAT HAPPENED HERE?  — summary", "=" * 66]

    counts: dict[str, int] = {}
    time_by_label: dict[str, float] = {}
    for ev in events:
        key = ev.label.replace(" (?)", "")
        counts[key] = counts.get(key, 0) + 1
        time_by_label[key] = time_by_label.get(key, 0.0) + ev.duration

    # --- one-sentence plain-language answer ------------------------------ #
    if events and counts:
        top_name, top_n = sorted(counts.items(), key=lambda kv: -kv[1])[0]
        loudest = max(events, key=lambda e: e.score)
        lines.append(
            f"\nIn one sentence: over {duration:.0f} s the microphone picked up "
            f"{len(events)} distinct sound events; the commonest was "
            f"\"{top_name}\" ({top_n} times), and the most confident single "
            f"detection is \"{loudest.label.replace(' (?)','')}\" at "
            f"{_mmss(loudest.start)}."
        )

    lines.append("\nMost frequent events:")
    for name, n in sorted(counts.items(), key=lambda kv: -kv[1])[:8]:
        lines.append(f"  {name:<34} x{n:<4} ({time_by_label[name]:.1f} s total)")

    # How much of the recording is speech?  Frame-level check, not just events.
    if len(scores):
        try:
            speech_idx = labels.index("Speech")
        except ValueError:
            speech_idx = None
        if speech_idx is not None and len(scores):
            speech_frames = scores[:, speech_idx] > SPEECH_THRESHOLD
            speech_sec = float(speech_frames.sum()) * YAMNET_HOP_SEC
            pct = 100.0 * speech_sec / duration if duration else 0.0
            lines.append(f"\nSpeech coverage: {speech_sec:.1f} s of "
                         f"{duration:.1f} s ({pct:.0f}% of the recording)")

    active = sum(ev.duration for ev in events)
    pct = 100.0 * active / duration if duration else 0.0
    lines.append(f"Detected activity: {active:.1f} s of {duration:.1f} s "
                 f"({pct:.0f}% of the recording was loud enough to be an event)")
    lines.append(f"Quietest gaps    : {duration - active:.1f} s")

    text = "\n".join(lines)
    print(text)
    return text


# --------------------------------------------------------------------------- #
# CLI
# --------------------------------------------------------------------------- #

def main(argv: list[str] | None = None) -> int:
    p = argparse.ArgumentParser(
        description="Describe what happened in a short everyday recording.")
    p.add_argument("audio", help="Path to the recording (wav/mp3/ogg/...)")
    p.add_argument("--outdir", default="output", help="Where to write results")
    p.add_argument("--duration", type=float, default=0.0,
                   help="Analyse only the first N seconds "
                        "(default 0 = the whole recording)")
    p.add_argument("--min-duration", type=float, default=DEFAULT_MIN_DURATION,
                   help="Ignore events shorter than this many seconds")
    p.add_argument("--merge-gap", type=float, default=DEFAULT_MERGE_GAP,
                   help="Merge events separated by less than this many seconds")
    p.add_argument("--on-margin", type=float, default=ON_MARGIN_DB,
                   help="dB above background that starts an event")
    p.add_argument("--off-margin", type=float, default=OFF_MARGIN_DB,
                   help="dB above background that ends an event")
    p.add_argument("--attack", type=float, default=DEFAULT_ATTACK_SEC,
                   help="Seconds the level must stay high before an event opens")
    p.add_argument("--release", type=float, default=DEFAULT_RELEASE_SEC,
                   help="Seconds the level must stay low before an event closes")
    p.add_argument("--skip-model", action="store_true",
                   help="Run only detection (no YAMNet, no network)")
    args = p.parse_args(argv)

    src = Path(args.audio)
    if not src.exists():
        print(f"error: file not found: {src}", file=sys.stderr)
        return 1
    outdir = Path(args.outdir)
    outdir.mkdir(parents=True, exist_ok=True)

    # --- 1. load & clean --------------------------------------------------- #
    print(f"[1/4] Loading and cleaning {src.name} ...")
    # --duration 0 (default) means "use the whole recording"; only trim when
    # the caller explicitly asks for a shorter window.
    window = args.duration if args.duration and args.duration > 0 else None
    audio = load_and_clean(src, TARGET_SR, window)
    duration = len(audio) / TARGET_SR
    print(f"      {duration:.1f}s @ {TARGET_SR} Hz, mono, "
          f"peak {np.max(np.abs(audio)):.3f}, "
          f"rms {20*np.log10(np.sqrt(np.mean(audio**2))):.1f} dB")

    # --- 2. detect --------------------------------------------------------- #
    print("[2/4] Detecting event boundaries from energy/loudness ...")
    events, dbg = detect_events(audio, TARGET_SR,
                                min_duration=args.min_duration,
                                merge_gap=args.merge_gap,
                                on_margin=args.on_margin,
                                off_margin=args.off_margin,
                                attack_sec=args.attack,
                                release_sec=args.release)
    print(f"      -> {len(events)} events found")

    # --- 3. label ---------------------------------------------------------- #
    scores = np.zeros((0, 521), dtype=np.float32)
    centers = np.zeros(0)
    labels: list[str] = []
    if not args.skip_model and events:
        print("[3/4] Labelling events with YAMNet ...")
        labeller = YamnetLabeller()
        scores, centers = labeller.scores(audio, TARGET_SR)
        labels = labeller.labels
        events = label_events(events, scores, centers, labels)
        print(f"      -> {len(scores)} YAMNet windows analysed")
    else:
        print("[3/4] Skipping YAMNet (--skip-model)")

    # --- 4. report --------------------------------------------------------- #
    print("[4/4] Writing spectrogram + table ...\n")
    png = outdir / "spectrogram.png"
    plot_spectrogram(audio, events, TARGET_SR, png, src.name, dbg)
    print(f"Spectrogram: {png}")

    table = print_table(events, duration)
    (outdir / "events.txt").write_text(table, encoding="utf-8")
    save_csv(events, outdir / "events.csv", duration)

    if labels:
        stats = statistics(events, scores, centers, labels, duration)
        (outdir / "summary.txt").write_text(table + "\n" + stats + "\n",
                                            encoding="utf-8")
    else:
        (outdir / "summary.txt").write_text(table + "\n", encoding="utf-8")

    print("\nDone.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

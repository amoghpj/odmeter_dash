import os
import json
import hashlib
import threading
import sys
import traceback
from datetime import datetime


def _ts():
    return datetime.now().strftime("%H:%M:%S")

import numpy as np
import pandas as pd
from scipy.optimize import minimize
from tqdm import tqdm

DATA_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "Data")
HASH_FILE = os.path.join(DATA_DIR, ".odmeterhash")

WINDOW_HALF_MIN = 10.0   # ±5 min → 10-min window
MIN_POINTS = 10          # expect ~30 pts/full window at 20 s interval; reject < 1/3

_status: dict[str, str] = {}
_status_lock = threading.Lock()
_registry_lock = threading.Lock()


def get_growth_rates_path(filepath):
    stem = os.path.splitext(os.path.basename(filepath))[0]
    return os.path.join(DATA_DIR, f".{stem}_growth_rates.csv")


def get_file_hash(filepath):
    h = hashlib.sha256()
    with open(filepath, "rb") as f:
        for chunk in iter(lambda: f.read(65536), b""):
            h.update(chunk)
    return h.hexdigest()


def _load_hash_registry():
    with _registry_lock:
        if not os.path.exists(HASH_FILE):
            return {}
        try:
            with open(HASH_FILE) as f:
                return json.load(f)
        except (json.JSONDecodeError, OSError):
            return {}


def _update_hash_registry(basename, hash_val):
    with _registry_lock:
        try:
            with open(HASH_FILE) as f:
                registry = json.load(f)
        except (FileNotFoundError, json.JSONDecodeError, OSError):
            registry = {}
        registry[basename] = hash_val
        tmp = HASH_FILE + ".tmp"
        with open(tmp, "w") as f:
            json.dump(registry, f, indent=2)
        os.replace(tmp, HASH_FILE)


def needs_recomputation(filepath):
    """True if the growth rates cache is absent or the source file has changed."""
    if not os.path.exists(get_growth_rates_path(filepath)):
        return True
    registry = _load_hash_registry()
    key = os.path.basename(filepath)
    if key not in registry:
        return True
    return registry[key] != get_file_hash(filepath)


def load_growth_rates(filepath):
    """Return a DataFrame of cached growth rates, or None if unavailable."""
    gr_path = get_growth_rates_path(filepath)
    if not os.path.exists(gr_path):
        return None
    try:
        return pd.read_csv(gr_path)
    except Exception:
        return None


def _fit_window(t_win, ln_od):
    """
    Fit ln(OD) = m*t + c using Nelder-Mead, warm-started from the OLS solution.
    Returns (m, c) — growth_rate and od_offset.
    """
    t_mean = t_win.mean()
    y_mean = ln_od.mean()
    dt = t_win - t_mean
    denom = float(np.dot(dt, dt))
    m0 = float(np.dot(dt, ln_od - y_mean)) / denom if denom > 0 else 0.0
    c0 = y_mean - m0 * t_mean

    def cost(params):
        return float(np.sum((ln_od - (params[0] * t_win + params[1])) ** 2))

    res = minimize(
        cost, [m0, c0], method="Nelder-Mead",
        options={"xatol": 1e-7, "fatol": 1e-10, "maxiter": 300},
    )
    return float(res.x[0]), float(res.x[1])


def _compute_series(t, od, pbar=None):
    """
    Sliding-window growth rates for one sorted (t, od) series.
    Window is centred on each data point; only positive OD values enter the fit.
    Returns list of (t_center, growth_rate, od_offset).
    """
    valid = od > 0
    t_v = t[valid]
    ln_od = np.log(od[valid])

    results = []
    for i in range(len(t)):
        t_c = t[i]
        lo = np.searchsorted(t_v, t_c - WINDOW_HALF_MIN)
        hi = np.searchsorted(t_v, t_c + WINDOW_HALF_MIN, side="right")
        if hi - lo < MIN_POINTS:
            if pbar is not None:
                pbar.update(1)
            continue
        m, c = _fit_window(t_v[lo:hi], ln_od[lo:hi])
        results.append((t_c, m, c))
        if pbar is not None:
            pbar.update(1)
    return results


def _worker(filepath, df):
    name = os.path.basename(filepath)
    print(f"[growth_rates {_ts()}] START {name}", flush=True)
    try:
        df = df.dropna(subset=["t_min", "converted_od"])
        current_hash = get_file_hash(filepath)

        rows = []
        groups = list(df.groupby(["device", "sample_name"], sort=False))
        print(f"[growth_rates {_ts()}] {name}: {len(groups)} series to process", flush=True)

        for (device, sample_name), grp in groups:
            grp = grp.sort_values("t_min").reset_index(drop=True)
            t = grp["t_min"].to_numpy(dtype=float)
            od = grp["converted_od"].to_numpy(dtype=float)
            with tqdm(total=len(t), desc=f"  dev {device} / {sample_name}", unit="pt", leave=True) as pbar:
                results = _compute_series(t, od, pbar=pbar)
            print(f"[growth_rates {_ts()}]   {device}/{sample_name}: {len(results)} windows from {len(t)} pts", flush=True)
            for t_c, m, c in results:
                rows.append({
                    "t_min": t_c,
                    "device": device,
                    "sample_name": sample_name,
                    "growth_rate": m * 60,  # convert ln OD/min → ln OD/hr
                    "od_offset": c,
                })

        out_path = get_growth_rates_path(filepath)
        pd.DataFrame(rows).to_csv(out_path, index=False)
        print(f"[growth_rates {_ts()}] Wrote {len(rows)} rows → {out_path}", flush=True)

        _update_hash_registry(os.path.basename(filepath), current_hash)

        with _status_lock:
            _status[filepath] = "done"
        print(f"[growth_rates {_ts()}] DONE {name}", flush=True)

    except Exception:
        print(f"[growth_rates {_ts()}] ERROR in worker for {name}:", flush=True)
        traceback.print_exc()
        sys.stdout.flush()
        with _status_lock:
            _status[filepath] = "error"


def trigger_computation(filepath, df):
    """Start background growth-rate computation; no-op if already running."""
    with _status_lock:
        if _status.get(filepath) == "computing":
            print(f"[growth_rates {_ts()}] already computing {os.path.basename(filepath)}", flush=True)
            return
        _status[filepath] = "computing"
    print(f"[growth_rates {_ts()}] spawning thread for {os.path.basename(filepath)}", flush=True)
    threading.Thread(target=_worker, args=(filepath, df.copy()), daemon=True).start()


def get_status(filepath):
    with _status_lock:
        return _status.get(filepath, "idle")

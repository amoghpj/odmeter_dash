"""
data_service.py — FastAPI service on port 8051

  • Proxies /api/* → Go server (GO_API env, default http://127.0.0.1:8080)
  • Serves data endpoints under /svc/
  • Serves built React SPA from frontend/dist/ if present
"""

import asyncio
import json
import os
import sys
import traceback
from pathlib import Path
from typing import Any

import httpx
import numpy as np
import pandas as pd
import uvicorn
import websockets
import yaml
from fastapi import FastAPI, Request, Response, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles

import growth_rates

# ── configuration ─────────────────────────────────────────────────────────────

GO_API = os.environ.get("GO_API", "http://127.0.0.1:8080")
# DATA_DIR is the fallback when Go config cannot be reached.
DATA_DIR = Path(os.environ.get("DATA_DIR", Path(__file__).parent / "Data"))
FRONTEND_DIST = Path(__file__).parent / "frontend" / "dist"


def _resolve_data_dirs() -> list[Path]:
    """
    Query Go /api/config/ for each user's data_path.
    Falls back to DATA_DIR if Go is unreachable or returns no paths.
    """
    if os.environ.get("DATA_DIR"):
        # Explicit override — use it directly.
        return [DATA_DIR]
    try:
        resp = httpx.get(f"{GO_API}/api/config/", timeout=3.0)
        if resp.status_code == 200:
            cfg = resp.json() or {}
            dirs: list[Path] = []
            for u in cfg.get("users") or []:
                dp = (u.get("data_path") or "").strip()
                if dp:
                    dirs.append(Path(dp).expanduser())
            if dirs:
                print(f"[data_service] data dirs from Go config: {dirs}", file=sys.stderr)
                return dirs
    except Exception as exc:
        print(f"[data_service] cannot reach Go config ({exc}), falling back to {DATA_DIR}",
              file=sys.stderr)
    return [DATA_DIR]


DATA_DIRS: list[Path] = _resolve_data_dirs()


def _find_csv(name: str) -> Path | None:
    """Return the first existing {name}.csv across all DATA_DIRS, or None."""
    for d in DATA_DIRS:
        p = d / f"{name}.csv"
        if p.exists():
            return p
    return None

PLOT_COLS = ["t_min", "converted_od", "device", "channel", "sample_name"]
MAX_POINTS = 500

# ── CSV cache: {filepath: (mtime, df)} ───────────────────────────────────────

_csv_cache: dict[str, tuple[float, Any]] = {}


# ── LTTB (verbatim from app.py) ───────────────────────────────────────────────

def lttb(t_arr, y_arr, n_out):
    """
    Largest Triangle Three Buckets downsampling.
    Selects n_out indices from t_arr/y_arr that best preserve visual shape.
    """
    n_in = len(t_arr)
    if n_in <= n_out:
        return np.arange(n_in)

    indices = np.empty(n_out, dtype=int)
    indices[0] = 0
    indices[-1] = n_in - 1
    bucket_size = (n_in - 2) / (n_out - 2)
    a = 0

    for i in range(n_out - 2):
        avg_start = int((i + 1) * bucket_size) + 1
        avg_end = min(int((i + 2) * bucket_size) + 1, n_in)
        avg_t = t_arr[avg_start:avg_end].mean()
        avg_y = y_arr[avg_start:avg_end].mean()

        rng_start = int(i * bucket_size) + 1
        rng_end = min(int((i + 1) * bucket_size) + 1, n_in)

        t_b = t_arr[rng_start:rng_end]
        y_b = y_arr[rng_start:rng_end]
        areas = np.abs(
            (t_arr[a] - avg_t) * (y_b - y_arr[a])
            - (t_arr[a] - t_b) * (avg_y - y_arr[a])
        ) * 0.5
        indices[i + 1] = rng_start + int(np.argmax(areas))
        a = indices[i + 1]

    return indices


def subsample_df(df, max_points=MAX_POINTS):
    """Apply LTTB per (device, channel) series."""
    parts = []
    for _, group in df.groupby(["device", "channel"], sort=False):
        group = group.sort_values("t_min").reset_index(drop=True)
        if len(group) > max_points:
            idx = lttb(
                group["t_min"].to_numpy(),
                group["converted_od"].to_numpy(),
                max_points,
            )
            group = group.iloc[idx]
        parts.append(group)
    return pd.concat(parts, ignore_index=True) if parts else df


# ── CSV helpers (ported from app.py) ─────────────────────────────────────────

def parse_csv_metadata(filepath: str) -> dict | None:
    """Read only the first line to extract the JSON metadata header."""
    try:
        with open(filepath, "r") as f:
            return json.loads(f.readline()[1:])
    except Exception:
        return None


def _read_and_process_csv(filepath: str) -> tuple[pd.DataFrame | None, str | None]:
    """Read full CSV, assign sample_name and t_min. Returns (df, error)."""
    try:
        meta = parse_csv_metadata(filepath)
        if meta is None:
            return None, "Could not parse metadata header"

        df = pd.read_csv(
            filepath,
            comment="#",
            usecols=["timestamp", "device", "channel", "converted_od"],
        )
        df["device"] = df["device"].apply(str)
        df["channel"] = df["channel"].apply(int)

        df["sample_name"] = ""
        for si in meta["sample_info"]:
            dev, ch = str(si["device"]), int(si["channel"])
            df.loc[(df["device"] == dev) & (df["channel"] == ch), "sample_name"] = si["name"]

        # Disambiguate duplicate sample names across devices
        for name in df["sample_name"].unique():
            dev_list = df[df["sample_name"] == name]["device"].unique()
            if len(dev_list) > 1:
                for dev in dev_list:
                    df.loc[
                        (df["device"] == dev) & (df["sample_name"] == name),
                        "sample_name",
                    ] = f"{name}_{dev}"

        ts_raw = meta.get("time_started")
        if ts_raw:
            time_started = pd.to_datetime(ts_raw, utc=True)
            df["t_min"] = (
                pd.to_datetime(df["timestamp"], format="ISO8601", utc=True) - time_started
            ).dt.total_seconds() / 60
        else:
            df["t_min"] = float("nan")

        return df[PLOT_COLS].copy(), None
    except Exception:
        tb = traceback.format_exc()
        print(tb, file=sys.stderr)
        return None, tb


def get_full_csv_data(filepath: str) -> tuple[pd.DataFrame | None, str | None]:
    """Return (df, error) for filepath. Re-reads only when mtime changes."""
    try:
        mtime = os.path.getmtime(filepath)
    except OSError:
        mtime = None

    cached = _csv_cache.get(filepath)
    if cached is not None and cached[0] == mtime:
        return cached[1]

    result = _read_and_process_csv(filepath)
    _csv_cache[filepath] = (mtime, result)
    return result


# ── FastAPI app ───────────────────────────────────────────────────────────────

app = FastAPI()

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

# ── proxy: /api/* → Go server ─────────────────────────────────────────────────

_SKIP_HEADERS = {"host", "content-length"}


@app.api_route("/api/{path:path}", methods=["GET", "POST", "PUT", "DELETE", "PATCH", "HEAD", "OPTIONS"])
async def proxy_api(path: str, request: Request):
    url = f"{GO_API}/api/{path}"
    params = dict(request.query_params)
    headers = {
        k: v
        for k, v in request.headers.items()
        if k.lower() not in _SKIP_HEADERS
    }
    body = await request.body()
    try:
        async with httpx.AsyncClient(timeout=30) as client:
            resp = await client.request(
                method=request.method,
                url=url,
                params=params,
                headers=headers,
                content=body,
            )
        return Response(
            content=resp.content,
            status_code=resp.status_code,
            headers=dict(resp.headers),
        )
    except httpx.ConnectError:
        return JSONResponse(
            {"error": "Go server unavailable"},
            status_code=503,
        )


# ── /svc/ws/ → Go WebSocket proxy ────────────────────────────────────────────

_GO_WS = GO_API.replace("http://", "ws://").replace("https://", "wss://") + "/api/ws/"


@app.websocket("/svc/ws/")
async def ws_proxy(websocket: WebSocket):
    await websocket.accept()
    try:
        async with websockets.connect(_GO_WS) as backend:
            async def fwd_to_client():
                try:
                    async for msg in backend:
                        if isinstance(msg, bytes):
                            await websocket.send_bytes(msg)
                        else:
                            await websocket.send_text(msg)
                except Exception:
                    pass

            async def fwd_to_backend():
                try:
                    while True:
                        data = await websocket.receive_text()
                        await backend.send(data)
                except (WebSocketDisconnect, Exception):
                    pass

            done, pending = await asyncio.wait(
                [asyncio.create_task(fwd_to_client()), asyncio.create_task(fwd_to_backend())],
                return_when=asyncio.FIRST_COMPLETED,
            )
            for task in pending:
                task.cancel()
    except Exception as e:
        print(f"[ws_proxy] {e}", file=sys.stderr)
        try:
            await websocket.close()
        except Exception:
            pass


# ── /svc/status ───────────────────────────────────────────────────────────────

@app.get("/svc/status")
async def svc_status():
    go_reachable = False
    try:
        async with httpx.AsyncClient(timeout=3.0) as client:
            r = await client.get(f"{GO_API}/api/config/")
            go_reachable = r.status_code == 200
    except Exception:
        pass

    dirs_info = []
    exp_count = 0
    seen: set[str] = set()
    for d in DATA_DIRS:
        exists = d.is_dir()
        count = 0
        if exists:
            for p in d.glob("*.csv"):
                if not p.stem.startswith(".") and not p.stem.endswith("_growth_rates"):
                    if p.stem not in seen:
                        seen.add(p.stem)
                        count += 1
        exp_count += count
        dirs_info.append({"path": str(d), "exists": exists, "experiments": count})

    return JSONResponse({
        "go_api": GO_API,
        "go_reachable": go_reachable,
        "data_dirs": dirs_info,
        "experiments_total": exp_count,
        "pandas_version": pd.__version__,
        "python_version": sys.version.split()[0],
    })


# ── /svc/experiments ──────────────────────────────────────────────────────────

@app.get("/svc/experiments")
async def list_experiments():
    results = []
    seen: set[str] = set()
    for data_dir in DATA_DIRS:
        if not data_dir.is_dir():
            continue
        for csv_path in sorted(data_dir.glob("*.csv")):
            if csv_path.stem.startswith('.') or csv_path.stem.endswith('_growth_rates'):
                continue
            if csv_path.stem in seen:
                continue
            seen.add(csv_path.stem)
            stat = csv_path.stat()
            meta = parse_csv_metadata(str(csv_path))
            entry: dict = {
                "name": csv_path.stem,
                "size_bytes": stat.st_size,
                "has_meta": meta is not None,
            }
            if meta:
                if "time_started" in meta:
                    entry["time_started"] = meta["time_started"]
                if "sample_info" in meta:
                    entry["sample_count"] = len(meta["sample_info"])
            results.append(entry)
    return JSONResponse(results)


# ── /svc/data/{name} ──────────────────────────────────────────────────────────

@app.get("/svc/data/{name}")
async def get_data(name: str, max_points: int = MAX_POINTS):
    csv_path = _find_csv(name)
    if csv_path is None:
        return JSONResponse({"error": f"File not found: {name}.csv"}, status_code=404)
    filepath = str(csv_path)

    df, err = get_full_csv_data(filepath)
    if df is None:
        return JSONResponse({"error": err}, status_code=500)

    total_rows = len(df)
    sampled = subsample_df(df, max_points=max_points)
    downsampled = len(sampled) < total_rows

    meta_raw = parse_csv_metadata(filepath)
    meta_out: dict = {}
    if meta_raw:
        if "time_started" in meta_raw:
            meta_out["time_started"] = meta_raw["time_started"]
        if "sample_info" in meta_raw:
            meta_out["sample_info"] = meta_raw["sample_info"]

    return JSONResponse({
        "rows": sampled.to_dict(orient="records"),
        "total_rows": total_rows,
        "downsampled": downsampled,
        "meta": meta_out,
    })


# ── /svc/config/{name} ───────────────────────────────────────────────────────

@app.get("/svc/config/{name}")
async def get_config(name: str):
    csv_path = _find_csv(name)
    base_dir = csv_path.parent if csv_path else DATA_DIRS[0]
    config_path = base_dir / f"{name}_config.yaml"
    if not config_path.exists():
        return JSONResponse({})
    try:
        with open(config_path, "r") as f:
            data = yaml.safe_load(f) or {}
        return JSONResponse(data)
    except Exception as exc:
        return JSONResponse({"error": str(exc)}, status_code=500)


@app.post("/svc/config/{name}")
async def save_config(name: str, request: Request):
    try:
        body = await request.json()
    except Exception:
        return JSONResponse({"error": "Invalid JSON body"}, status_code=400)

    csv_path = _find_csv(name)
    base_dir = csv_path.parent if csv_path else DATA_DIRS[0]
    base_dir.mkdir(parents=True, exist_ok=True)
    config_path = base_dir / f"{name}_config.yaml"
    try:
        with open(config_path, "w") as f:
            yaml.dump(body, f, default_flow_style=False)
        return JSONResponse({"saved": str(config_path)})
    except Exception as exc:
        return JSONResponse({"error": str(exc)}, status_code=500)


# ── /svc/growth-rates/{name} ─────────────────────────────────────────────────

@app.get("/svc/growth-rates/{name}")
async def get_growth_rates(name: str):
    csv_path = _find_csv(name)
    if csv_path is None:
        return JSONResponse({"error": f"File not found: {name}.csv"}, status_code=404)
    filepath = str(csv_path)

    status = growth_rates.get_status(filepath)

    if status == "idle" and growth_rates.needs_recomputation(filepath):
        df, err = get_full_csv_data(filepath)
        if df is not None:
            growth_rates.trigger_computation(filepath, df)
            status = growth_rates.get_status(filepath)
        else:
            return JSONResponse({"error": err, "status": "error", "rows": None}, status_code=500)

    gr_df = growth_rates.load_growth_rates(filepath)
    rows = gr_df.to_dict(orient="records") if gr_df is not None else None

    return JSONResponse({
        "status": status,
        "rows": rows,
    })


# ── SPA / static files from frontend/dist ────────────────────────────────────

_INDEX_HTML = FRONTEND_DIST / "index.html"

if FRONTEND_DIST.is_dir():
    assets_dir = FRONTEND_DIST / "assets"
    if assets_dir.is_dir():
        app.mount("/assets", StaticFiles(directory=str(assets_dir)), name="assets")

    @app.get("/{full_path:path}", include_in_schema=False)
    async def spa_fallback(full_path: str):
        # Serve real files that live directly in dist (e.g. favicon.ico, manifest.json)
        candidate = FRONTEND_DIST / full_path
        if candidate.is_file():
            return FileResponse(str(candidate))
        # Everything else → index.html
        if _INDEX_HTML.exists():
            return FileResponse(str(_INDEX_HTML))
        return JSONResponse({"error": "Frontend not built"}, status_code=404)


# ── entrypoint ────────────────────────────────────────────────────────────────

if __name__ == "__main__":
    uvicorn.run("data_service:app", host="0.0.0.0", port=8051, reload=False)

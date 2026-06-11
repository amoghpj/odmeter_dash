import os
import glob
import json
import traceback
import sys
import threading
import collections
from datetime import datetime

import numpy as np
import dash
from dash import dcc, html, Input, Output, State, ALL, MATCH, ctx, Patch
import plotly.graph_objects as go
import requests
import pandas as pd

import growth_rates

SERVER_ADDR = "127.0.0.1:8080"
POLL_INTERVAL_MS = 10_000
DATA_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "Data")
PLOT_COLS = ["t_min", "converted_od", "device", "sample_name"]
MAX_POINTS = 500  # per sample per plot

# History tab: single-file cache (filepath + mtime as key)
_cached_filepath = None
_cached_df = None
_cached_mtime = None

# WebSocket-driven live buffer
_ws_buffer: collections.deque = collections.deque()  # new readings only; history comes from CSV cache
_ws_buffer_lock = threading.Lock()
_ws_counter = 0          # incremented whenever new rows land in the buffer
_ws_last_seen: dict = {} # (device, channel) -> last t_str, for deduplication
_ws_active_filepath: str | None = None
_ws_meta: dict = {}      # filepath -> {time_started, sample_map, valid_pairs}


# ── shared ────────────────────────────────────────────────────────────────────

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
    """Apply LTTB per (device, sample_name) series."""
    parts = []
    for _, group in df.groupby(["device", "sample_name"], sort=False):
        group = group.sort_values("t_min").reset_index(drop=True)
        if len(group) > max_points:
            idx = lttb(group["t_min"].to_numpy(), group["converted_od"].to_numpy(), max_points)
            group = group.iloc[idx]
        parts.append(group)
    return pd.concat(parts, ignore_index=True) if parts else df


# Plotly's default discrete colour sequence
_PLOTLY_COLORS = [
    "#636EFA", "#EF553B", "#00CC96", "#AB63FA", "#FFA15A",
    "#19D3F3", "#FF6692", "#B6E880", "#FF97FF", "#FECB52",
]

def _trace_color(i):
    return _PLOTLY_COLORS[i % len(_PLOTLY_COLORS)]


def _legend_pills(trace_names, store_id, graph_id):
    """Row of colored pill buttons + a Reset button for custom legend control."""
    pills = []
    for i, name in enumerate(trace_names):
        color = _trace_color(i)
        pills.append(html.Button(
            name,
            id={"type": store_id + "-btn", "index": graph_id, "trace": i},
            n_clicks=0,
            style={
                "background": color,
                "color": "#fff",
                "border": "none",
                "borderRadius": "12px",
                "padding": "3px 12px",
                "marginRight": "6px",
                "marginBottom": "4px",
                "fontSize": "12px",
                "cursor": "pointer",
                "opacity": "1",
            },
        ))
    pills.append(html.Button(
        "Reset",
        id={"type": store_id + "-reset", "index": graph_id},
        n_clicks=0,
        style={
            "background": "#eee",
            "color": "#333",
            "border": "1px solid #ccc",
            "borderRadius": "12px",
            "padding": "3px 10px",
            "fontSize": "12px",
            "cursor": "pointer",
        },
    ))
    return html.Div(pills, style={"padding": "4px 8px 0"})


def make_plots(df, graph_id_type=None, x_range=None, y_scale="linear"):
    """One dcc.Graph per device, one trace per sample_name."""
    df = df.copy()
    df["device"] = df["device"].astype(str)
    plots = []
    for device in sorted(df["device"].unique()):
        dev_df = df[df["device"] == device]
        sample_names = sorted(dev_df["sample_name"].unique())
        fig = go.Figure()
        for i, sample_name in enumerate(sample_names):
            s = dev_df[dev_df["sample_name"] == sample_name].sort_values("t_min")
            fig.add_trace(go.Scatter(
                x=s["t_min"],
                y=s["converted_od"],
                mode="lines+markers",
                name=sample_name,
                line={"color": _trace_color(i)},
                marker={"color": _trace_color(i)},
            ))
        layout = dict(
            title=f"Device {device}",
            xaxis_title="Time (min)",
            yaxis_title="Converted OD",
            showlegend=False,
            height=400,
            margin={"l": 60, "r": 20, "t": 50, "b": 50},
        )
        if y_scale == "log":
            pos = dev_df["converted_od"][dev_df["converted_od"] > 0]
            upper = float(np.ceil(np.log10(pos.max()) + 0.5)) if len(pos) else 1.0
            layout["yaxis"] = {"type": "log", "range": [-3, upper]}
        else:
            layout["yaxis_type"] = "linear"
        if x_range is not None:
            layout["xaxis_range"] = x_range
        fig.update_layout(**layout)

        graph_id = {"type": graph_id_type or "live-graph", "index": device}
        store_type = "od-legend-state" if graph_id_type == "browser-graph" else "live-legend-state"
        plots.append(dcc.Store(
            id={"type": store_type, "index": device},
            data=list(range(len(sample_names))),
        ))
        plots.append(_legend_pills(sample_names, store_type, device))
        plots.append(dcc.Graph(id=graph_id, figure=fig))
    return plots


def make_growth_rate_plots(gr_df, max_points=MAX_POINTS):
    """One dcc.Graph per device showing sliding-window growth rate over time."""
    gr_df = gr_df.copy()
    gr_df["device"] = gr_df["device"].astype(str)
    plots = []
    for device in sorted(gr_df["device"].unique()):
        dev_df = gr_df[gr_df["device"] == device]
        sample_names = sorted(dev_df["sample_name"].unique())
        fig = go.Figure()
        for i, sample_name in enumerate(sample_names):
            s = (
                dev_df[dev_df["sample_name"] == sample_name]
                .sort_values("t_min")
                .reset_index(drop=True)
            )
            if len(s) > max_points:
                idx = lttb(s["t_min"].to_numpy(), s["growth_rate"].to_numpy(), max_points)
                s = s.iloc[idx]
            fig.add_trace(go.Scatter(
                x=s["t_min"],
                y=s["growth_rate"],
                mode="lines",
                name=sample_name,
                line={"color": _trace_color(i)},
            ))
        fig.update_layout(
            title=f"Device {device} — Growth Rate",
            xaxis_title="Time (min)",
            yaxis_title="Growth rate (ln OD / hr)",
            showlegend=False,
            height=360,
            margin={"l": 60, "r": 20, "t": 50, "b": 50},
        )
        plots.append(dcc.Store(
            id={"type": "gr-legend-state", "index": device},
            data=list(range(len(sample_names))),
        ))
        plots.append(_legend_pills(sample_names, "gr-legend-state", device))
        plots.append(dcc.Graph(id={"type": "gr-graph", "index": device}, figure=fig))
    return plots


def _build_growth_rate_section(filepath):
    """
    Trigger recomputation if needed and return (gr_content, poll_disabled).
    Called only when a new file is selected.
    """
    if growth_rates.needs_recomputation(filepath):
        full_df, _ = get_full_csv_data(filepath)
        if full_df is not None:
            growth_rates.trigger_computation(filepath, full_df)

    computing = growth_rates.get_status(filepath) == "computing"
    gr_df = growth_rates.load_growth_rates(filepath)

    header = [html.Hr(style={"margin": "24px 0 12px"}),
              html.H4("Growth Rates", style={"marginTop": "0", "marginBottom": "12px"})]

    if gr_df is not None:
        if computing:
            header.append(html.P(
                "Recomputing growth rates in background…",
                style={"color": "gray", "fontSize": "12px", "fontStyle": "italic"},
            ))
        content = header + make_growth_rate_plots(gr_df)
    else:
        msg = "Computing growth rates in background…" if computing else "Growth rates not yet computed."
        content = header + [html.P(msg, style={"color": "gray"})]

    return content, not computing


# ── live tab helpers ──────────────────────────────────────────────────────────

def get_experiments():
    try:
        return requests.get(f"http://{SERVER_ADDR}/api/acqusition/", timeout=3).json()
    except Exception:
        return []


def live_csv_path(exp_name):
    return os.path.join(DATA_DIR, f"{exp_name}.csv")


# ── browser tab helpers ───────────────────────────────────────────────────────

def parse_csv_metadata(filepath):
    """Read only the first line to extract the JSON metadata header."""
    try:
        with open(filepath, "r") as f:
            return json.loads(f.readline()[1:])
    except Exception:
        return None


def _read_and_process_csv(filepath):
    """Read full CSV, assign sample_name and t_min. Returns PLOT_COLS df or None."""
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

        for name in df["sample_name"].unique():
            dev_list = df[df["sample_name"] == name]["device"].unique()
            if len(dev_list) > 1:
                for dev in dev_list:
                    df.loc[
                        (df["device"] == dev) & (df["sample_name"] == name), "sample_name"
                    ] = f"{name}_{dev}"

        time_started = pd.to_datetime(meta["time_started"], utc=True)
        df["t_min"] = (
            pd.to_datetime(df["timestamp"], format="ISO8601", utc=True) - time_started
        ).dt.total_seconds() / 60

        return df[PLOT_COLS].copy(), None
    except Exception:
        tb = traceback.format_exc()
        print(tb, file=sys.stderr)
        return None, tb


def get_full_csv_data(filepath):
    """Return (df, error) for filepath. Re-reads only when filepath or mtime changes."""
    global _cached_filepath, _cached_df, _cached_mtime
    try:
        mtime = os.path.getmtime(filepath)
    except OSError:
        mtime = None
    if _cached_filepath == filepath and _cached_mtime == mtime:
        return _cached_df
    _cached_filepath = filepath
    _cached_mtime = mtime
    _cached_df = _read_and_process_csv(filepath)
    return _cached_df


def _load_ws_meta(filepath):
    """Parse and cache the experiment metadata needed to process WebSocket readings."""
    if filepath in _ws_meta:
        return _ws_meta[filepath]
    meta = parse_csv_metadata(filepath)
    if meta is None:
        return None
    time_started = pd.to_datetime(meta["time_started"], utc=True)
    sample_map = {}
    for si in meta["sample_info"]:
        key = (str(si["device"]), int(si["channel"]))
        sample_map[key] = si["name"]
    _ws_meta[filepath] = {
        "time_started": time_started,
        "sample_map": sample_map,
        "valid_pairs": set(sample_map.keys()),
    }
    return _ws_meta[filepath]


def _seed_ws_buffer(filepath):
    """Prepare for live updates from a newly selected experiment.

    History comes from the CSV cache; we only populate _ws_last_seen so the
    WebSocket consumer knows which readings are already on disk and skips them.
    """
    global _ws_counter, _ws_active_filepath
    _load_ws_meta(filepath)
    # Re-read the CSV to get the latest timestamps per channel
    df, _ = _read_and_process_csv(filepath)
    with _ws_buffer_lock:
        _ws_buffer.clear()
        _ws_last_seen.clear()
        _ws_active_filepath = filepath
        if df is not None:
            # Record the last timestamp string seen per (device, channel) so
            # the WS consumer won't re-add readings already written to the CSV.
            try:
                raw = pd.read_csv(filepath, comment="#",
                                  usecols=["timestamp", "device", "channel"])
                raw["device"] = raw["device"].astype(str)
                raw["channel"] = raw["channel"].astype(int)
                for (dev, ch), grp in raw.groupby(["device", "channel"]):
                    _ws_last_seen[(dev, ch)] = grp["timestamp"].iloc[-1]
            except Exception:
                pass
        _ws_counter += 1


def _get_ws_dataframe(filepath):
    """Combine the full CSV history with any new readings received via WebSocket."""
    hist_df, _ = get_full_csv_data(filepath)
    with _ws_buffer_lock:
        new_rows = list(_ws_buffer)
    if not new_rows:
        return hist_df  # may be None if CSV not yet available
    new_df = pd.DataFrame(new_rows)[PLOT_COLS]
    if hist_df is None:
        return new_df
    return pd.concat([hist_df, new_df], ignore_index=True)


def get_plot_data(filepath, t_range=None):
    """Return (subsampled_df_or_None, error_or_None), filtered to t_range if provided."""
    df, err = get_full_csv_data(filepath)
    if df is None:
        return None, err
    if t_range is not None:
        df = df[(df["t_min"] >= t_range[0]) & (df["t_min"] <= t_range[1])]
        if df.empty:
            return df, None
    return subsample_df(df), None


_TH_STYLE = {
    "textAlign": "left",
    "padding": "4px 12px 4px 4px",
    "borderBottom": "1px solid #ccc",
    "fontSize": "12px",
    "color": "#555",
}
_TD_STYLE = {"padding": "3px 12px 3px 4px", "fontSize": "13px"}


def build_file_accordion():
    """Scan Data/ and build accordion items. Reads only the metadata header line per file."""
    if not os.path.isdir(DATA_DIR):
        return [html.P("No Data/ directory found.", style={"color": "gray"})]

    csv_files = sorted(glob.glob(os.path.join(DATA_DIR, "*.csv")))
    if not csv_files:
        return [html.P("No CSV files found in Data/.", style={"color": "gray"})]

    items = []
    for filepath in csv_files:
        filename = os.path.basename(filepath)
        meta = parse_csv_metadata(filepath)

        if meta and "sample_info" in meta:
            rows = [
                html.Tr([
                    html.Td(str(si["device"]), style=_TD_STYLE),
                    html.Td(str(si["channel"]), style=_TD_STYLE),
                    html.Td(si["name"], style=_TD_STYLE),
                ])
                for si in meta["sample_info"]
            ]
            table = html.Table(
                [
                    html.Thead(html.Tr([
                        html.Th("Device", style=_TH_STYLE),
                        html.Th("Channel", style=_TH_STYLE),
                        html.Th("Sample", style=_TH_STYLE),
                    ])),
                    html.Tbody(rows),
                ],
                style={"borderCollapse": "collapse", "margin": "8px 0 12px 4px"},
            )
        else:
            table = html.P("Could not parse metadata.", style={"color": "red", "fontSize": "12px"})

        items.append(html.Details(
            [
                html.Summary(
                    filename,
                    style={
                        "cursor": "pointer",
                        "padding": "6px 4px",
                        "fontWeight": "bold",
                        "fontSize": "14px",
                        "userSelect": "none",
                    },
                ),
                table,
                html.Div(
                    [
                        html.Button(
                            "Plot",
                            id={"type": "plot-btn", "index": filepath},
                            n_clicks=0,
                            style={"padding": "5px 18px", "fontSize": "13px", "cursor": "pointer"},
                        ),
                        html.Button(
                            "⬇ Download",
                            id={"type": "download-btn", "index": filepath},
                            n_clicks=0,
                            style={"padding": "5px 14px", "fontSize": "13px", "cursor": "pointer", "marginLeft": "6px"},
                        ),
                    ],
                    style={"margin": "0 4px 12px"},
                ),
            ],
            style={"borderBottom": "1px solid #eee", "paddingBottom": "4px"},
        ))

    return items


# ── layout ────────────────────────────────────────────────────────────────────

_NAV_BASE = {
    "display": "block",
    "width": "100%",
    "padding": "10px 16px",
    "textAlign": "left",
    "border": "none",
    "borderLeft": "3px solid transparent",
    "background": "none",
    "cursor": "pointer",
    "fontSize": "14px",
    "whiteSpace": "nowrap",
    "overflow": "hidden",
}
_NAV_ACTIVE = {
    **_NAV_BASE,
    "background": "#eef2ff",
    "borderLeft": "3px solid #4a6cf7",
    "fontWeight": "bold",
}
_SIDEBAR_OPEN = {
    "width": "190px",
    "minWidth": "190px",
    "borderRight": "1px solid #ddd",
    "overflowY": "auto",
    "overflowX": "hidden",
    "transition": "min-width 0.2s, width 0.2s",
    "paddingTop": "8px",
}
_SIDEBAR_CLOSED = {
    "width": "0",
    "minWidth": "0",
    "overflow": "hidden",
    "transition": "min-width 0.2s, width 0.2s",
}

app = dash.Dash(__name__)

app.layout = html.Div(
    [
        # ── shared state ──────────────────────────────────────────────────────
        dcc.Store(id="active-tab", data="tab-live"),
        dcc.Store(id="sidebar-open", data=True),
        dcc.Store(id="data-store", storage_type="memory"),
        dcc.Store(id="selected-file"),
        dcc.Store(id="browser-zoom-range"),
        dcc.Store(id="live-paused", data=False),
        dcc.Interval(id="poll-interval", interval=POLL_INTERVAL_MS, n_intervals=0),
        dcc.Interval(id="gr-poll", interval=5000, n_intervals=0, disabled=True),
        dcc.Download(id="download-csv"),

        # ── header ────────────────────────────────────────────────────────────
        html.Div(
            [
                html.Button(
                    "☰",
                    id="sidebar-toggle",
                    n_clicks=0,
                    title="Toggle sidebar",
                    style={
                        "border": "none",
                        "background": "none",
                        "cursor": "pointer",
                        "fontSize": "20px",
                        "lineHeight": "1",
                        "padding": "0 14px 0 0",
                    },
                ),
                html.Span("ODMeter Dashboard", style={"fontWeight": "bold", "fontSize": "18px"}),
                html.Div(style={"flex": "1"}),
                html.Span("Scale:", style={"fontSize": "13px", "color": "#555", "marginRight": "6px"}),
                dcc.RadioItems(
                    id="y-scale",
                    options=[
                        {"label": " Linear", "value": "linear"},
                        {"label": " Log₁₀", "value": "log"},
                    ],
                    value="linear",
                    inline=True,
                    inputStyle={"marginRight": "3px"},
                    labelStyle={"marginRight": "14px", "fontSize": "13px"},
                ),
            ],
            style={
                "display": "flex",
                "alignItems": "center",
                "padding": "10px 16px",
                "borderBottom": "1px solid #ddd",
                "background": "#f8f8f8",
                "height": "48px",
                "boxSizing": "border-box",
            },
        ),

        # ── body: sidebar + content ───────────────────────────────────────────
        html.Div(
            [
                # Sidebar nav
                html.Div(
                    [
                        html.Button("Live", id="nav-live", n_clicks=0, style=_NAV_ACTIVE),
                        html.Button("History", id="nav-browser", n_clicks=0, style=_NAV_BASE),
                    ],
                    id="sidebar",
                    style=_SIDEBAR_OPEN,
                ),

                # Content pane
                html.Div(
                    [
                        # Live content
                        html.Div(
                            [
                                html.Div(
                                    [
                                        html.Label("Experiment:", style={"fontWeight": "bold", "marginRight": "8px"}),
                                        dcc.Dropdown(id="exp-selector", style={"width": "420px", "display": "inline-block", "marginRight": "12px"}),
                                        html.Button("⏸ Pause", id="pause-btn", n_clicks=0, style={"fontSize": "13px", "cursor": "pointer"}),
                                    ],
                                    style={"margin": "16px 20px 8px", "display": "flex", "alignItems": "center"},
                                ),
                                html.Div(id="status-bar", style={"margin": "0 20px 12px", "color": "gray", "fontSize": "12px"}),
                                html.Div(id="plots-container"),
                            ],
                            id="content-live",
                        ),

                        # Browser content
                        html.Div(
                            html.Div(
                                [
                                    html.Div(
                                        id="file-list",
                                        style={
                                            "width": "25%",
                                            "minWidth": "200px",
                                            "overflowY": "auto",
                                            "borderRight": "1px solid #ddd",
                                            "padding": "16px 12px",
                                        },
                                    ),
                                    html.Div(
                                        [
                                            html.P(
                                                "Click a file to expand it, then press Plot.",
                                                id="browser-status",
                                                style={"color": "gray"},
                                            ),
                                            html.Div(id="browser-plot-area"),
                                            html.Div(id="browser-gr-area"),
                                        ],
                                        id="browser-plots",
                                        style={"flex": "1", "overflowY": "auto", "padding": "16px 20px"},
                                    ),
                                ],
                                style={"display": "flex", "height": "calc(100vh - 48px)"},
                            ),
                            id="content-browser",
                            style={"display": "none"},
                        ),
                    ],
                    style={"flex": "1", "overflowY": "auto", "minWidth": "0"},
                ),
            ],
            style={"display": "flex", "height": "calc(100vh - 48px)"},
        ),
    ],
    style={"fontFamily": "sans-serif"},
)


# ── nav / sidebar callbacks ───────────────────────────────────────────────────

@app.callback(
    Output("active-tab", "data"),
    Input("nav-live", "n_clicks"),
    Input("nav-browser", "n_clicks"),
    prevent_initial_call=True,
)
def set_active_tab(_, __):
    return "tab-live" if ctx.triggered_id == "nav-live" else "tab-browser"


@app.callback(
    Output("sidebar-open", "data"),
    Input("sidebar-toggle", "n_clicks"),
    State("sidebar-open", "data"),
    prevent_initial_call=True,
)
def toggle_sidebar(_, is_open):
    return not is_open


@app.callback(
    Output("sidebar", "style"),
    Output("nav-live", "style"),
    Output("nav-browser", "style"),
    Input("active-tab", "data"),
    Input("sidebar-open", "data"),
)
def update_sidebar(active_tab, is_open):
    sidebar_style = _SIDEBAR_OPEN if is_open else _SIDEBAR_CLOSED
    live_style = _NAV_ACTIVE if active_tab == "tab-live" else _NAV_BASE
    browser_style = _NAV_ACTIVE if active_tab == "tab-browser" else _NAV_BASE
    return sidebar_style, live_style, browser_style


@app.callback(
    Output("content-live", "style"),
    Output("content-browser", "style"),
    Input("active-tab", "data"),
)
def show_active_content(active_tab):
    show = {"display": "block"}
    hide = {"display": "none"}
    return (show if active_tab == "tab-live" else hide,
            show if active_tab == "tab-browser" else hide)


# ── live callbacks ────────────────────────────────────────────────────────────

@app.callback(
    Output("exp-selector", "options"),
    Output("exp-selector", "value"),
    Input("poll-interval", "n_intervals"),
    State("exp-selector", "value"),
)
def update_experiment_list(n, current_value):
    experiments = get_experiments()
    if not experiments:
        return [], current_value
    options = [{"label": e["name"], "value": e["name"]} for e in experiments]
    running = next((e["name"] for e in experiments if e.get("status") == "running"), None)
    value = current_value or running or experiments[-1]["name"]
    return options, value


@app.callback(
    Output("live-paused", "data"),
    Output("pause-btn", "children"),
    Input("pause-btn", "n_clicks"),
    State("live-paused", "data"),
    prevent_initial_call=True,
)
def toggle_pause(_, paused):
    new_paused = not paused
    return new_paused, "▶ Resume" if new_paused else "⏸ Pause"


@app.callback(
    Output("data-store", "data"),
    Output("status-bar", "children"),
    Input("poll-interval", "n_intervals"),
    State("exp-selector", "value"),
    State("data-store", "data"),
    State("live-paused", "data"),
)
def poll_server(n, exp_name, cached, paused):
    now = pd.Timestamp.now().strftime("%H:%M:%S")
    if paused:
        return dash.no_update, f"Paused. Last update: {now}"
    if not exp_name:
        return dash.no_update, "No experiment selected."
    filepath = live_csv_path(exp_name)

    cached_exp = (cached or {}).get("exp_name")
    cached_counter = (cached or {}).get("ws_counter", -1)

    if cached_exp != exp_name:
        # Experiment changed (or first load): seed buffer from CSV
        if not os.path.exists(filepath):
            return dash.no_update, f"Waiting for data file… Last checked: {now}"
        _seed_ws_buffer(filepath)
        try:
            size_kb = os.path.getsize(filepath) // 1024
        except OSError:
            size_kb = 0
        return (
            {"exp_name": exp_name, "ws_counter": _ws_counter},
            f"Loaded {size_kb:,} kb from disk. Watching for live data… {now}",
        )

    if _ws_counter == cached_counter:
        return dash.no_update, f"Waiting for data… {now}"

    n_new = len(_ws_buffer)
    return (
        {"exp_name": exp_name, "ws_counter": _ws_counter},
        f"Live — {n_new:,} new readings via WebSocket. Last updated: {now}",
    )


@app.callback(
    Output("plots-container", "children"),
    Input("data-store", "data"),
    Input("y-scale", "value"),
)
def render_live_plots(signal, y_scale):
    if not signal:
        return html.P("Waiting for data...", style={"margin": "20px", "color": "gray"})
    exp_name = signal.get("exp_name")
    if not exp_name:
        return html.P("Waiting for data...", style={"margin": "20px", "color": "gray"})
    filepath = live_csv_path(exp_name)
    df = _get_ws_dataframe(filepath)
    if df is None or df.empty:
        return html.P("No data yet.", style={"margin": "20px", "color": "gray"})
    return make_plots(subsample_df(df), y_scale=y_scale)


# ── browser callbacks ─────────────────────────────────────────────────────────

@app.callback(
    Output("file-list", "children"),
    Input("active-tab", "data"),
    prevent_initial_call=True,
)
def load_file_list(active_tab):
    if active_tab != "tab-browser":
        return dash.no_update
    return build_file_accordion()


@app.callback(
    Output("selected-file", "data"),
    Input({"type": "plot-btn", "index": ALL}, "n_clicks"),
    prevent_initial_call=True,
)
def select_file(_):
    if not ctx.triggered_id or not ctx.triggered[0]["value"]:
        return dash.no_update
    return ctx.triggered_id["index"]


@app.callback(
    Output("browser-zoom-range", "data"),
    Input({"type": "browser-graph", "index": ALL}, "relayoutData"),
    prevent_initial_call=True,
)
def update_zoom_range(relayout_list):
    if not ctx.triggered:
        return dash.no_update
    relay = ctx.triggered[0]["value"]
    if not relay or relay.get("autosize"):
        return dash.no_update
    if relay.get("xaxis.autorange"):
        return None
    x0 = relay.get("xaxis.range[0]")
    x1 = relay.get("xaxis.range[1]")
    if x0 is not None and x1 is not None:
        return [float(x0), float(x1)]
    return dash.no_update


@app.callback(
    Output("browser-status", "children"),
    Input("selected-file", "data"),
    prevent_initial_call=True,
)
def show_waiting(filepath):
    if not filepath:
        return dash.no_update
    size_kb = os.path.getsize(filepath) // 1024
    return f"Waiting for {size_kb:,} kb of data..."


@app.callback(
    Output("browser-plot-area", "children"),
    Output("browser-status", "children", allow_duplicate=True),
    Output("browser-gr-area", "children"),
    Output("gr-poll", "disabled"),
    Input("selected-file", "data"),
    Input("browser-zoom-range", "data"),
    Input("y-scale", "value"),
    prevent_initial_call=True,
)
def render_browser_plots(filepath, zoom_range, y_scale):
    _no = dash.no_update
    if not filepath:
        return _no, _no, _no, _no
    if ctx.triggered_id == "selected-file":
        zoom_range = None
    df, err = get_plot_data(filepath, t_range=zoom_range)
    if df is None:
        return (
            html.Pre(
                f"Error loading {os.path.basename(filepath)}:\n\n{err}",
                style={"color": "red", "fontSize": "12px", "whiteSpace": "pre-wrap"},
            ),
            "", _no, _no,
        )
    if df.empty:
        return html.P("No data in selected range.", style={"color": "gray"}), "", _no, _no
    plots = (
        [html.H4(os.path.basename(filepath), style={"marginTop": "0"})]
        + make_plots(df, graph_id_type="browser-graph", x_range=zoom_range, y_scale=y_scale)
    )
    if ctx.triggered_id == "selected-file":
        gr_content, poll_disabled = _build_growth_rate_section(filepath)
        return plots, "", gr_content, poll_disabled
    return plots, "", _no, _no


@app.callback(
    Output("download-csv", "data"),
    Input({"type": "download-btn", "index": ALL}, "n_clicks"),
    prevent_initial_call=True,
)
def download_csv(_):
    if not ctx.triggered_id or not ctx.triggered[0]["value"]:
        return dash.no_update
    return dcc.send_file(ctx.triggered_id["index"])


def _apply_pill_click(btn_clicks, reset_clicks, figure, visible_list):
    """
    Pill-button legend logic (called for both OD and growth-rate graphs):
      - Click a visible trace while others also visible → isolate it
      - Click the only visible trace → restore all
      - Click a hidden trace → add it to the visible set
      - Click Reset → restore all
    """
    if not figure:
        return dash.no_update, dash.no_update

    n = len(figure["data"])
    all_i = set(range(n))
    visible = set(visible_list) if visible_list is not None else all_i

    triggered = ctx.triggered_id
    if triggered is None:
        return dash.no_update, dash.no_update

    # Reset button
    if isinstance(triggered, dict) and "reset" in triggered.get("type", ""):
        patch = Patch()
        for i in range(n):
            patch["data"][i]["visible"] = True
        return patch, list(all_i)

    # Pill button — which trace index?
    trace_idx = int(triggered["trace"])

    if trace_idx in visible:
        if len(visible) == 1:
            # Only trace visible → restore all
            new_visible = all_i
        else:
            # Isolate this trace
            new_visible = {trace_idx}
    else:
        # Hidden trace → add to visible set
        new_visible = visible | {trace_idx}

    patch = Patch()
    for i in range(n):
        patch["data"][i]["visible"] = True if i in new_visible else "legendonly"
    return patch, list(new_visible)


@app.callback(
    Output({"type": "browser-graph", "index": MATCH}, "figure"),
    Output({"type": "od-legend-state", "index": MATCH}, "data"),
    Input({"type": "od-legend-state-btn", "index": MATCH, "trace": ALL}, "n_clicks"),
    Input({"type": "od-legend-state-reset", "index": MATCH}, "n_clicks"),
    State({"type": "browser-graph", "index": MATCH}, "figure"),
    State({"type": "od-legend-state", "index": MATCH}, "data"),
    prevent_initial_call=True,
)
def handle_od_pill_click(btn_clicks, reset_clicks, figure, visible_list):
    return _apply_pill_click(btn_clicks, reset_clicks, figure, visible_list)


@app.callback(
    Output({"type": "live-graph", "index": MATCH}, "figure"),
    Output({"type": "live-legend-state", "index": MATCH}, "data"),
    Input({"type": "live-legend-state-btn", "index": MATCH, "trace": ALL}, "n_clicks"),
    Input({"type": "live-legend-state-reset", "index": MATCH}, "n_clicks"),
    State({"type": "live-graph", "index": MATCH}, "figure"),
    State({"type": "live-legend-state", "index": MATCH}, "data"),
    prevent_initial_call=True,
)
def handle_live_pill_click(btn_clicks, reset_clicks, figure, visible_list):
    return _apply_pill_click(btn_clicks, reset_clicks, figure, visible_list)


@app.callback(
    Output({"type": "gr-graph", "index": MATCH}, "figure"),
    Output({"type": "gr-legend-state", "index": MATCH}, "data"),
    Input({"type": "gr-legend-state-btn", "index": MATCH, "trace": ALL}, "n_clicks"),
    Input({"type": "gr-legend-state-reset", "index": MATCH}, "n_clicks"),
    State({"type": "gr-graph", "index": MATCH}, "figure"),
    State({"type": "gr-legend-state", "index": MATCH}, "data"),
    prevent_initial_call=True,
)
def handle_gr_pill_click(btn_clicks, reset_clicks, figure, visible_list):
    return _apply_pill_click(btn_clicks, reset_clicks, figure, visible_list)


@app.callback(
    Output("browser-gr-area", "children", allow_duplicate=True),
    Output("gr-poll", "disabled", allow_duplicate=True),
    Input("gr-poll", "n_intervals"),
    State("selected-file", "data"),
    prevent_initial_call=True,
)
def poll_growth_rates(_, filepath):
    if not filepath:
        return dash.no_update, True

    status = growth_rates.get_status(filepath)

    if status == "computing":
        return dash.no_update, False  # still running — keep firing

    if status == "done":
        gr_df = growth_rates.load_growth_rates(filepath)
        if gr_df is not None and not gr_df.empty:
            content = [
                html.Hr(style={"margin": "24px 0 12px"}),
                html.H4("Growth Rates", style={"marginTop": "0", "marginBottom": "12px"}),
                *make_growth_rate_plots(gr_df),
            ]
        else:
            content = [
                html.Hr(style={"margin": "24px 0 12px"}),
                html.P("Growth rate computation finished but produced no results "
                       "(all windows may have had too few positive OD points).",
                       style={"color": "gray"}),
            ]
        return content, True

    if status == "error":
        content = [
            html.Hr(style={"margin": "24px 0 12px"}),
            html.P("Growth rate computation failed — see server terminal for the traceback.",
                   style={"color": "red"}),
        ]
        return content, True  # stop polling, show error

    return dash.no_update, True  # idle — nothing to do


# ── WebSocket live consumer ───────────────────────────────────────────────────

import websocket as _websocket
import time as _time

def _ws_consumer():
    def _ts():
        return datetime.now().strftime("%H:%M:%S.%f")[:-3]

    def on_open(ws):
        print(f"[WS {_ts()}] connected to ws://{SERVER_ADDR}/api/ws/", flush=True)

    def on_message(ws, message):
        global _ws_counter
        try:
            msg = json.loads(message)
            if msg.get("eventType") != "NewReadings":
                return
            filepath = _ws_active_filepath
            if filepath is None:
                return
            meta = _ws_meta.get(filepath)
            if meta is None:
                return
            new_rows = []
            with _ws_buffer_lock:
                for r in msg.get("readings", []):
                    key = (str(r["device"]), int(r["channel"]))
                    t_str = r["t"]
                    if _ws_last_seen.get(key) == t_str:
                        continue  # duplicate broadcast
                    if key not in meta["valid_pairs"]:
                        continue  # not part of active experiment
                    _ws_last_seen[key] = t_str
                    t_dt = pd.to_datetime(t_str, utc=True)
                    t_min = (t_dt - meta["time_started"]).total_seconds() / 60
                    new_rows.append({
                        "t_min": t_min,
                        "device": str(r["device"]),
                        "sample_name": meta["sample_map"].get(key, f"{r['device']}.{r['channel']}"),
                        "converted_od": float(r["converted_od"]),
                    })
                if new_rows:
                    _ws_buffer.extend(new_rows)
                    _ws_counter += 1
                    print(f"[WS {_ts()}] +{len(new_rows)} rows (buffer={len(_ws_buffer)})", flush=True)
        except Exception as e:
            print(f"[WS {_ts()}] parse error: {e}", flush=True)

    def on_error(ws, error):
        print(f"[WS {_ts()}] error: {error}", flush=True)

    def on_close(ws, code, msg):
        print(f"[WS {_ts()}] closed (code={code})", flush=True)

    while True:
        try:
            _websocket.WebSocketApp(
                f"ws://{SERVER_ADDR}/api/ws/",
                on_open=on_open,
                on_message=on_message,
                on_error=on_error,
                on_close=on_close,
            ).run_forever()
        except Exception as e:
            print(f"[WS {_ts()}] connect failed: {e}", flush=True)
        _time.sleep(5)

_ws_thread = threading.Thread(target=_ws_consumer, daemon=True)
_ws_thread.start()


if __name__ == "__main__":
    app.run(debug=True, host="0.0.0.0", port=8050)

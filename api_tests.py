#!/usr/bin/env python3
"""
ODMeter API diagnostic suite.

Usage:
    python api_tests.py                          # read-only health checks
    python api_tests.py --write                  # include sample/experiment lifecycle
    python api_tests.py --interval               # interval accuracy test (no running exps)
    python api_tests.py --addr 192.168.1.10:8080
"""

import argparse
import json
import statistics
import threading
import time
from dataclasses import dataclass, field
from typing import Optional

import requests
import websocket as _websocket

SERVER_ADDR = "127.0.0.1:8080"

INTERVAL_TARGETS = [10, 15, 20]   # seconds
N_PER_INTERVAL   = 3              # readings to collect per target interval
_SENTINEL        = "_diag_"       # prefix for all test-created objects


@dataclass
class TestResult:
    name:        str
    endpoint:    str
    method:      str
    passed:      bool
    status_code: Optional[int]   = None
    elapsed_ms:  Optional[float] = None
    detail:      str             = ""
    raw:         object          = None


@dataclass
class IntervalResult:
    target_s:      int
    n_received:    int   = 0
    mean_s:        float = 0.0
    stdev_s:       float = 0.0
    max_dev_s:     float = 0.0
    raw_intervals: list  = field(default_factory=list)
    passed:        bool  = False
    error:         str   = ""


class ODMeterTester:
    def __init__(self, server_addr: str = SERVER_ADDR):
        self.addr   = server_addr
        self.base   = f"http://{server_addr}/api"
        self.ws_url = f"ws://{server_addr}/api/ws/"

    # ── internal helpers ──────────────────────────────────────────────────────

    def _req(self, method: str, path: str, **kwargs):
        """Single timed HTTP request. Returns (body, elapsed_ms, status_code, error)."""
        url = self.base + path
        t0  = time.monotonic()
        try:
            resp = getattr(requests, method)(url, timeout=10, **kwargs)
            ms   = (time.monotonic() - t0) * 1000
            try:
                body = resp.json()
            except Exception:
                body = resp.text
            return body, ms, resp.status_code, None
        except Exception as exc:
            ms = (time.monotonic() - t0) * 1000
            return None, ms, None, str(exc)

    def _collect_ws(self, n: int, timeout_s: float) -> list[float]:
        """
        Open a fresh WS connection; return monotonic timestamps of the first n
        NewReadings events received within timeout_s seconds.
        """
        timestamps: list[float] = []
        done = threading.Event()

        def on_msg(ws, msg):
            try:
                if json.loads(msg).get("eventType") == "NewReadings":
                    timestamps.append(time.monotonic())
                    if len(timestamps) >= n:
                        ws.close()
            except Exception:
                pass

        def on_close(ws, *_):  done.set()
        def on_error(ws, *_):  done.set()

        ws = _websocket.WebSocketApp(
            self.ws_url, on_message=on_msg, on_close=on_close, on_error=on_error,
        )
        threading.Thread(target=ws.run_forever, daemon=True).start()
        done.wait(timeout=timeout_s)
        return timestamps

    def _free_channel(self):
        """Return (device_label, channel_int) for the first unoccupied channel, or (None, None)."""
        body, _, _, _ = self._req("get", "/device/")
        for dev in (body or []):
            for ch in dev.get("channels", []):
                if not ch.get("enabled"):
                    return dev["label"], ch["channel"]
        return None, None

    def _config_defaults(self):
        """Return (first_user_name, first_standard_curve_name, first_user_data_path)."""
        body, _, _, _ = self._req("get", "/config/")
        users  = (body or {}).get("users", [{}])
        curves = (body or {}).get("standard_curves", [{}])
        return (
            users[0].get("name", "")      if users  else "",
            curves[0].get("name", "")     if curves else "",
            users[0].get("data_path", "") if users  else "",
        )

    # ── health checks (always safe, read-only) ────────────────────────────────

    def test_config(self) -> TestResult:
        body, ms, code, err = self._req("get", "/config/")
        if err:
            return TestResult("config", "/api/config/", "GET", False, detail=err, elapsed_ms=ms)
        ok = code == 200 and isinstance(body, dict) and "users" in body
        detail = (
            f"{len(body.get('users', []))} user(s), "
            f"{len(body.get('standard_curves', []))} standard curve(s)"
            if ok else f"HTTP {code}"
        )
        return TestResult("config", "/api/config/", "GET", ok, code, ms, detail, body)

    def test_devices(self) -> TestResult:
        body, ms, code, err = self._req("get", "/device/")
        if err:
            return TestResult("devices", "/api/device/", "GET", False, detail=err, elapsed_ms=ms)
        ok = code == 200 and isinstance(body, list)
        if ok:
            n_ch  = sum(len(d.get("channels", [])) for d in body)
            n_on  = sum(1 for d in body for c in d.get("channels", []) if c.get("enabled"))
            detail = f"{len(body)} device(s), {n_ch} channels, {n_on} in use"
        else:
            detail = f"HTTP {code}"
        return TestResult("devices", "/api/device/", "GET", ok, code, ms, detail, body)

    def test_samples(self) -> TestResult:
        body, ms, code, err = self._req("get", "/sample/")
        if err:
            return TestResult("samples", "/api/sample/", "GET", False, detail=err, elapsed_ms=ms)
        ok     = code == 200 and isinstance(body, list)
        detail = f"{len(body)} sample(s)" if ok else f"HTTP {code}"
        return TestResult("samples", "/api/sample/", "GET", ok, code, ms, detail, body)

    def test_experiments(self) -> TestResult:
        body, ms, code, err = self._req("get", "/acqusition/")
        if err:
            return TestResult("experiments", "/api/acqusition/", "GET", False, detail=err, elapsed_ms=ms)
        ok = code == 200 and isinstance(body, list)
        if ok:
            n_run  = sum(1 for e in body if e.get("is_running"))
            detail = f"{len(body)} experiment(s), {n_run} running"
        else:
            detail = f"HTTP {code}"
        return TestResult("experiments", "/api/acqusition/", "GET", ok, code, ms, detail, body)

    def test_websocket(self, timeout: int = 30) -> TestResult:
        """Connect and wait for a NewReadings message; measures time-to-first-message."""
        t0      = time.monotonic()
        t_msg   = [None]
        err_ref = [None]
        done    = threading.Event()

        def on_msg(ws, msg):
            try:
                if json.loads(msg).get("eventType") == "NewReadings" and t_msg[0] is None:
                    t_msg[0] = time.monotonic()
                    ws.close()
            except Exception:
                pass

        def on_error(ws, exc): err_ref[0] = str(exc); done.set()
        def on_close(ws, *_):  done.set()

        ws = _websocket.WebSocketApp(
            self.ws_url, on_message=on_msg, on_error=on_error, on_close=on_close,
        )
        threading.Thread(target=ws.run_forever, daemon=True).start()
        done.wait(timeout=timeout + 2)
        ms = (time.monotonic() - t0) * 1000

        if err_ref[0]:
            return TestResult("websocket", self.ws_url, "WS", False, detail=err_ref[0], elapsed_ms=ms)
        if t_msg[0] is None:
            return TestResult("websocket", self.ws_url, "WS", False,
                              detail=f"No NewReadings within {timeout}s", elapsed_ms=ms)
        detail = f"First message after {t_msg[0] - t0:.1f}s"
        return TestResult("websocket", self.ws_url, "WS", True, detail=detail, elapsed_ms=ms)

    def run_read_tests(self) -> list[TestResult]:
        return [
            self.test_config(),
            self.test_devices(),
            self.test_samples(),
            self.test_experiments(),
            self.test_websocket(),
        ]

    # ── write lifecycle ───────────────────────────────────────────────────────

    def run_write_tests(self) -> list[TestResult]:
        """
        Creates a sample and experiment with the sentinel prefix, exercises every
        write endpoint, then deletes everything. Safe to run repeatedly.
        """
        results: list[TestResult] = []
        dev_label, ch_num = self._free_channel()
        if dev_label is None:
            return [TestResult("write/free-channel", "/api/device/", "GET", False,
                               detail="No free channel — all occupied")]

        user, sc_name, _ = self._config_defaults()
        sample_uuid       = None
        exp_name          = _SENTINEL + "exp"

        try:
            # 1. Create sample
            resp, ms, code, err = self._req("post", "/sample/", json=[{
                "device": dev_label, "channel": ch_num,
                "name": _SENTINEL + "sample", "metadata": {"source": "diagnostic"},
                "standard_curve_name": sc_name, "user": user,
            }])
            ok = not err and code == 200 and isinstance(resp, list)
            results.append(TestResult(
                "write/create-sample", "/api/sample/", "POST", ok, code, ms,
                f"Created {dev_label}.{ch_num}" if ok else str(err or resp), resp,
            ))
            if not ok:
                return results
            sample_uuid = resp[0]["uuid"]

            # 2. Verify appears in list
            body, ms, code, _ = self._req("get", "/sample/")
            found = any(s.get("uuid") == sample_uuid for s in (body or []))
            results.append(TestResult(
                "write/verify-sample", "/api/sample/", "GET", found, code, ms,
                "UUID present in GET /api/sample/" if found else "UUID not found",
            ))

            # 3. Create experiment
            _, ms, code, err = self._req("post", "/acqusition/", json={
                "name": exp_name, "user": user,
                "description": "diagnostic write test",
                "interval": 10, "samples": [{"uuid": sample_uuid}],
            })
            ok = not err and code == 200
            results.append(TestResult(
                "write/create-experiment", "/api/acqusition/", "POST", ok, code, ms,
                "Created" if ok else str(err or code),
            ))
            if not ok:
                return results

            # 4. Modify experiment (partial update)
            _, ms, code, err = self._req("post", f"/acqusition/{exp_name}/",
                                         json={"description": "modified by diagnostic"})
            ok = not err and code == 200
            results.append(TestResult(
                "write/modify-experiment", f"/api/acqusition/{exp_name}/", "POST", ok, code, ms,
                "Description updated" if ok else str(err or code),
            ))

            # 5. Start
            _, ms, code, err = self._req("get", f"/acqusition/{exp_name}/start/")
            ok_start = not err and code == 200
            results.append(TestResult(
                "write/start", f"/api/acqusition/{exp_name}/start/", "GET", ok_start, code, ms,
                "Started" if ok_start else str(err or code),
            ))

            # 6. Verify is_running
            body, ms, code, _ = self._req("get", "/acqusition/")
            running = any(e.get("name") == exp_name and e.get("is_running") for e in (body or []))
            results.append(TestResult(
                "write/verify-running", "/api/acqusition/", "GET", running, code, ms,
                "is_running=true confirmed" if running else "is_running not true",
            ))

            # 7. Stop
            _, ms, code, err = self._req("get", f"/acqusition/{exp_name}/stop/")
            ok_stop = not err and code == 200
            results.append(TestResult(
                "write/stop", f"/api/acqusition/{exp_name}/stop/", "GET", ok_stop, code, ms,
                "Stopped" if ok_stop else str(err or code),
            ))
            time.sleep(0.3)

            # 8. Close
            _, ms, code, err = self._req("get", f"/acqusition/{exp_name}/close/")
            ok_close = not err and code == 200
            results.append(TestResult(
                "write/close", f"/api/acqusition/{exp_name}/close/", "GET", ok_close, code, ms,
                "Closed" if ok_close else str(err or code),
            ))

        finally:
            # Always clean up the sample
            if dev_label and ch_num:
                _, ms, code, err = self._req(
                    "delete", "/sample/", json=[{"device": dev_label, "channel": ch_num}]
                )
                results.append(TestResult(
                    "write/delete-sample", "/api/sample/", "DELETE",
                    not err and code == 200, code, ms,
                    "Cleaned up" if not err and code == 200 else str(err or code),
                ))

        return results

    # ── interval accuracy test ────────────────────────────────────────────────

    def measure_interval_accuracy(
        self,
        targets: list[int] = None,
        n_per:   int        = N_PER_INTERVAL,
    ) -> list[IntervalResult]:
        """
        For each target interval (seconds):
          - Creates a test sample on the first free channel
          - Creates + starts an experiment with that interval
          - Listens on WebSocket for n_per NewReadings events
          - Measures inter-arrival times vs the configured interval
          - Stops, closes, moves to next target
        Cleans up the test sample at the end regardless.

        Guard: refuses to run if any experiment is already running, to avoid
        corrupting an active acquisition by adding a sample to its device.
        """
        if targets is None:
            targets = INTERVAL_TARGETS

        # Guard: no running experiments
        exps, _, _, _ = self._req("get", "/acqusition/")
        if any(e.get("is_running") for e in (exps or [])):
            return [IntervalResult(0, error="An experiment is already running — stop it first")]

        dev_label, ch_num = self._free_channel()
        if dev_label is None:
            return [IntervalResult(0, error="No free channel available")]

        user, sc_name, data_path = self._config_defaults()
        run_id = int(time.time())
        results: list[IntervalResult] = []

        # Create persistent test sample (lives across all interval iterations)
        resp, _, code, err = self._req("post", "/sample/", json=[{
            "device": dev_label, "channel": ch_num,
            "name": _SENTINEL + "isample", "metadata": {},
            "standard_curve_name": sc_name, "user": user,
        }])
        if err or code != 200:
            return [IntervalResult(0, error=f"Could not create test sample: {err or code}")]

        sample_uuid = resp[0]["uuid"]

        try:
            for target_s in targets:
                res      = IntervalResult(target_s=target_s)
                exp_name = f"{_SENTINEL}iv{target_s}s_{run_id}"

                # Remove leftover CSV from a previous interrupted run if present
                if data_path:
                    import os as _os
                    stale = _os.path.join(data_path, exp_name + ".csv")
                    if _os.path.exists(stale):
                        _os.remove(stale)

                # Create experiment with this interval
                _, _, code, err = self._req("post", "/acqusition/", json={
                    "name": exp_name, "user": user,
                    "description": f"interval accuracy test {target_s}s",
                    "interval": target_s,
                    "samples": [{"uuid": sample_uuid}],
                })
                if err or code != 200:
                    res.error = f"Create experiment failed: {err or code}"
                    results.append(res)
                    continue

                # Start
                _, _, code, err = self._req("get", f"/acqusition/{exp_name}/start/")
                if err or code != 200:
                    res.error = f"Start failed: {err or code}"
                    results.append(res)
                    self._req("get", f"/acqusition/{exp_name}/close/")
                    continue

                # Collect n_per readings; allow up to (n_per + 3) full intervals
                timeout_s  = (n_per + 3) * target_s + 5
                timestamps = self._collect_ws(n_per, timeout_s)

                # Stop then close (must stop first — Close() has no running guard)
                self._req("get", f"/acqusition/{exp_name}/stop/")
                time.sleep(0.5)
                self._req("get", f"/acqusition/{exp_name}/close/")

                res.n_received = len(timestamps)
                if len(timestamps) >= 2:
                    ivs           = [timestamps[i+1] - timestamps[i]
                                     for i in range(len(timestamps) - 1)]
                    res.mean_s    = round(statistics.mean(ivs), 3)
                    res.stdev_s   = round(statistics.stdev(ivs), 3) if len(ivs) > 1 else 0.0
                    res.max_dev_s = round(max(abs(iv - target_s) for iv in ivs), 3)
                    res.raw_intervals = [round(iv, 3) for iv in ivs]
                    res.passed    = res.max_dev_s < 2.0   # within 2 s of target
                else:
                    res.error = f"Only received {len(timestamps)}/{n_per} readings"

                results.append(res)

        finally:
            self._req("delete", "/sample/", json=[{"device": dev_label, "channel": ch_num}])

        return results


# ── CLI entry point ───────────────────────────────────────────────────────────

def _print_results(results: list[TestResult]):
    for r in results:
        tag     = "PASS" if r.passed else "FAIL"
        ms_str  = f"{r.elapsed_ms:>7.0f} ms" if r.elapsed_ms is not None else "       --"
        code    = str(r.status_code) if r.status_code else "---"
        print(f"  [{tag}]  {r.name:<30}  {r.method:<6}  {code}  {ms_str}  {r.detail}")


def _print_interval_results(results: list[IntervalResult]):
    header = f"  {'Target':>8}  {'Recv':>5}  {'Mean':>8}  {'StdDev':>8}  {'MaxDev':>8}  {'Pass?':>6}  Intervals (s)"
    print(header)
    print("  " + "-" * (len(header) - 2))
    for r in results:
        if r.error:
            print(f"  {r.target_s:>7}s  ERROR: {r.error}")
        else:
            tag = "PASS" if r.passed else "WARN"
            print(f"  {r.target_s:>7}s  {r.n_received:>5}  {r.mean_s:>7.3f}s  "
                  f"{r.stdev_s:>7.3f}s  {r.max_dev_s:>7.3f}s  {tag:>6}  {r.raw_intervals}")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="ODMeter API diagnostic suite")
    parser.add_argument("--addr",     default=SERVER_ADDR, help="server address (host:port)")
    parser.add_argument("--write",    action="store_true",  help="run write lifecycle tests")
    parser.add_argument("--interval", action="store_true",  help="run interval accuracy test")
    parser.add_argument("--targets",  nargs="+", type=int,  default=INTERVAL_TARGETS,
                        help="interval targets in seconds (default: 10 15 20)")
    parser.add_argument("--n",        type=int,             default=N_PER_INTERVAL,
                        help="readings to collect per interval target")
    args = parser.parse_args()

    tester = ODMeterTester(args.addr)

    print(f"\nODMeter API Diagnostics  [{args.addr}]")
    print("─" * 60)

    print("\n Health Checks")
    results = tester.run_read_tests()
    _print_results(results)
    passed  = sum(1 for r in results if r.passed)
    print(f"\n  {passed}/{len(results)} passed")

    if args.write:
        print("\n Write Lifecycle Tests")
        write_results = tester.run_write_tests()
        _print_results(write_results)
        passed = sum(1 for r in write_results if r.passed)
        print(f"\n  {passed}/{len(write_results)} passed")

    if args.interval:
        print(f"\n Interval Accuracy Test  (targets={args.targets}, n={args.n})")
        print(f"  Estimated time: ~{sum(args.targets) * args.n + 30}s")
        iv_results = tester.measure_interval_accuracy(args.targets, args.n)
        _print_interval_results(iv_results)

    print()

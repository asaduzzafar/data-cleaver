"""Smoke-test an installed or built Data Cleaver against a throwaway profile.

Launches the exe with LOCALAPPDATA pointed at a temp folder, waits for the
first-run sample install, runs a query, exports it as .xlsx (which needs the
bundled excel extension), then closes the app.

    python sda/desktop/smoke.py build/dist/DataCleaver/DataCleaver.exe [--clean]

--clean runs it with an empty profile and a Windows-only PATH.
"""

import json
import os
import subprocess
import sys
import tempfile
import time
import urllib.request
from pathlib import Path


def call(port, path, body=None):
    req = urllib.request.Request(
        f"http://127.0.0.1:{port}/api{path}",
        data=None if body is None else json.dumps(body).encode(),
        headers={"Content-Type": "application/json"},
        method="GET" if body is None else "POST")
    with urllib.request.urlopen(req, timeout=30) as r:
        return json.loads(r.read())


def wait(what, check, timeout):
    end = time.monotonic() + timeout
    while time.monotonic() < end:
        try:
            value = check()
            if value:
                return value
        except Exception:
            pass
        time.sleep(0.5)
    raise SystemExit(f"FAIL: {what} within {timeout}s")


def job(port, started, timeout=120):
    done = wait(f"job {started['id']}", lambda: (
        lambda j: j if j["state"] in ("done", "error", "cancelled") else None
    )(call(port, f"/jobs/{started['id']}")), timeout)
    if done["state"] != "done":
        raise SystemExit(f"FAIL: job {done.get('label')}: {done.get('error')}")
    return done["result"]


def clean_env(home):
    """As close to a fresh machine as one process gets: an empty profile (so
    DuckDB cannot fall back to extensions in ~/.duckdb) and a PATH with
    nothing but Windows on it (so no Python or developer tools leak in)."""
    windir = os.environ.get("SystemRoot", r"C:\Windows")
    keep = ("SystemRoot", "SystemDrive", "windir", "ComSpec", "PATHEXT",
            "NUMBER_OF_PROCESSORS", "PROCESSOR_ARCHITECTURE", "OS")
    env = {k: os.environ[k] for k in keep if k in os.environ}
    for d in ("AppData/Local", "AppData/Roaming", "Temp"):
        (home / d).mkdir(parents=True, exist_ok=True)
    env.update(PATH=f"{windir}\\System32;{windir}", USERPROFILE=str(home),
               HOME=str(home), APPDATA=str(home / "AppData/Roaming"),
               LOCALAPPDATA=str(home / "AppData/Local"),
               TEMP=str(home / "Temp"), TMP=str(home / "Temp"),
               USERNAME=os.environ.get("USERNAME", "smoke"))
    return env


def main(exe, clean=False):
    root = Path(tempfile.mkdtemp(prefix="datacleaver-smoke-"))
    env = clean_env(root) if clean else {**os.environ, "LOCALAPPDATA": str(root)}
    folder = Path(env["LOCALAPPDATA"]) / "DataCleaver"
    t0 = time.monotonic()
    proc = subprocess.Popen([exe], env=env)
    try:
        port = wait("the port file", lambda: (folder / "instance.port").read_text().strip(), 60)
        wait("health", lambda: call(port, "/health")["status"] == "ok", 60)
        print(f"up on :{port} in {time.monotonic() - t0:.1f}s")
        wait("the sample install", lambda: call(port, "/sample")["state"] == "installed", 180)
        names = sorted(r["name"] for r in call(port, "/relations")["relations"])
        print(f"sample installed at {time.monotonic() - t0:.1f}s: {names}")
        assert "sample_orders" in names, names

        result = job(port, call(port, "/query", {
            "mode": "sql", "relation": "sample_orders", "page": 1, "page_size": 10,
            "sql": 'SELECT product_code, count(*) AS n FROM "sample_orders" '
                   "GROUP BY 1 ORDER BY n DESC"}))
        print(f"query: {result['total']} rows, first {result['rows'][0]}")

        started = call(port, "/query", {"mode": "sql", "relation": "sample_orders",
                                        "sql": 'SELECT * FROM "sample_orders" LIMIT 1000',
                                        "page": 1, "page_size": 10})
        job(port, started)
        export = job(port, call(port, "/export", {"job_id": started["id"], "format": "xlsx"}))
        print(f"xlsx export: {export['rows']} rows, {export['bytes']:,} bytes")
        assert export["bytes"] > 0
        if clean:
            stray = list(root.glob(".duckdb/extensions/**/*.duckdb_extension"))
            assert not stray, f"downloaded into the profile: {stray}"
            print("no extension was downloaded: the bundled one was used")
        print("PASS")
    finally:
        proc.terminate()
        proc.wait(timeout=30)


if __name__ == "__main__":
    main(str(Path(sys.argv[1]).resolve()), clean="--clean" in sys.argv[2:])

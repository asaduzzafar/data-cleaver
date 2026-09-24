"""Start Data Cleaver as a local app: `python -m app`.

Listens on loopback only. The app has no login, so anything that can reach
the port can read every loaded file and run SQL; exposing it to the network
has to be a deliberate, spelled-out choice, not a default.
"""

import argparse
import ipaddress
import socket

import uvicorn

from .config import Config
from .main import create_app

LOOPBACK_NAMES = {"localhost"}


def check_host(host, *, allow_remote):
    if allow_remote:
        return
    if host in LOOPBACK_NAMES:
        return
    try:
        if ipaddress.ip_address(host).is_loopback:
            return
    except ValueError:
        pass
    raise SystemExit(
        f"refusing to listen on {host}: Data Cleaver has no login, so it only "
        "listens on a loopback address (127.0.0.1). Pass --allow-remote if you "
        "really mean to expose it.")


def free_port(host):
    """A port the OS says is free right now."""
    family = socket.AF_INET6 if ":" in host else socket.AF_INET
    with socket.socket(family, socket.SOCK_STREAM) as s:
        s.bind((host, 0))
        return s.getsockname()[1]


def main(argv=None):
    ap = argparse.ArgumentParser(prog="datacleaver")
    ap.add_argument("--host", default="127.0.0.1")
    ap.add_argument("--port", type=int, default=0,
                    help="0 picks a free port")
    ap.add_argument("--allow-remote", action="store_true",
                    help="listen on a non-loopback address")
    args = ap.parse_args(argv)

    check_host(args.host, allow_remote=args.allow_remote)
    cfg = Config.local()
    port = args.port or free_port(args.host)
    if cfg.frontend_dist is None:
        print("note: no built UI found; run `npm run build` in sda/frontend. "
              "Serving the API only.", flush=True)
    print(f"Data Cleaver: http://{args.host}:{port}/  "
          f"(data in {cfg.db_path.parent}, memory limit {cfg.memory_limit})",
          flush=True)
    # One worker, always: DuckDB's file lock admits a single process.
    uvicorn.run(create_app(cfg), host=args.host, port=port, workers=1,
                log_level="warning")


if __name__ == "__main__":
    main()

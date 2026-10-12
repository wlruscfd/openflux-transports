#!/usr/bin/env python3
"""Packs and signs every transport and rewrites its update.json.

    python tools/build.py --server /path/to/openflux-server --key /path/to/transports_priv.key [--channel stable] [--notes "..."]

Each <id>/manifest.json + <id>/src/<id>.js becomes <id>/<id>-<version>.flux, and <id>/update.json points the stable
channel at it. Clients accept a package only when it verifies under the project key built into the app.
"""
import argparse
import glob
import json
import os
import subprocess

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
RAW = "https://raw.githubusercontent.com/wlruscfd/openflux-transports/main"


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--server", required=True)
    ap.add_argument("--key", required=True)
    ap.add_argument("--channel", default="stable")
    ap.add_argument("--notes", default="")
    args = ap.parse_args()

    def sign(*a):
        subprocess.run(["go", "run", "./transport/script/cmd/scriptsign", *a], cwd=args.server, check=True,
                       env=dict(os.environ, GOFLAGS="-mod=mod", GOPROXY="off"))

    for manifest in sorted(glob.glob(os.path.join(ROOT, "*", "manifest.json"))):
        d = os.path.dirname(manifest)
        tid = os.path.basename(d)
        with open(manifest, encoding="utf-8") as f:
            version = json.load(f)["version"]
        name = "%s-%s.flux" % (tid, version)
        out = os.path.join(d, name)
        for old in glob.glob(os.path.join(d, tid + "-*.flux")):
            os.remove(old)
        sign("pack", os.path.abspath(args.key), manifest, os.path.join(d, "src", tid + ".js"), out)
        sign("index", "-channel=" + args.channel, "-url=" + name, "-notes=" + args.notes, os.path.join(d, "update.json"), out)
        print("built", os.path.relpath(out, ROOT))


if __name__ == "__main__":
    main()

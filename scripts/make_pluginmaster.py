#!/usr/bin/env python3
"""Build the Dalamud custom-repository file (pluginmaster.json) for a release.

DalamudPackager writes the plugin manifest (FcHub.json) next to latest.zip. Dalamud's plugin
installer needs that manifest plus download links and a timestamp, wrapped in a JSON array.

Usage:
  make_pluginmaster.py <manifest.json> <tag> <owner/repo> <out.json>

Download links point at this release's latest.zip; users subscribe to
  https://github.com/<owner/repo>/releases/latest/download/pluginmaster.json
which GitHub always redirects to the newest release.
"""

from __future__ import annotations

import json
import sys
import time
from pathlib import Path

REQUIRED = ("InternalName", "Name", "AssemblyVersion", "Author", "DalamudApiLevel")


def build(manifest: dict, tag: str, repository: str, now: int) -> list[dict]:
    missing = [key for key in REQUIRED if not manifest.get(key)]
    if missing:
        raise SystemExit(f"manifest is missing {', '.join(missing)}")

    expected_tag = f"v{manifest['AssemblyVersion']}"
    if tag != expected_tag:
        raise SystemExit(f"tag {tag} doesn't match the plugin version (expected {expected_tag}); bump <Version> in FcHub.csproj")

    download = f"https://github.com/{repository}/releases/download/{tag}/latest.zip"
    entry = dict(manifest)
    entry.update(
        {
            "DownloadLinkInstall": download,
            "DownloadLinkUpdate": download,
            "DownloadLinkTesting": download,
            "IsHide": False,
            "IsTestingExclusive": False,
            "LastUpdate": now,
            "DownloadCount": 0,
        }
    )
    return [entry]


def main(argv: list[str]) -> None:
    if len(argv) != 5:
        raise SystemExit(__doc__)
    manifest_path, tag, repository, out_path = argv[1:]
    manifest = json.loads(Path(manifest_path).read_text(encoding="utf-8-sig"))
    result = build(manifest, tag, repository, int(time.time()))
    Path(out_path).write_text(json.dumps(result, indent=2) + "\n", encoding="utf-8")
    print(f"wrote {out_path}: {result[0]['Name']} {result[0]['AssemblyVersion']} -> {result[0]['DownloadLinkInstall']}")


if __name__ == "__main__":
    main(sys.argv)

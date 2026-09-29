"""Thin wrapper around the stackql binary. The only module that shells out to it."""

import io
import json
import os
import platform
import shutil
import subprocess
import urllib.request
import zipfile
from pathlib import Path
from typing import Any

APPROOT = Path(".stackql")
PROVIDER = "github"
DOWNLOAD_URL = "https://releases.stackql.io/stackql/latest/stackql_{system}_{arch}.zip"
READ_TOKEN_VAR = "REPO_WARDEN_READ_TOKEN"
WRITE_TOKEN_VAR = "REPO_WARDEN_WRITE_TOKEN"

Row = dict[str, Any]


class StackQLError(RuntimeError):
    """stackql reported an error or is not installed."""


def binary() -> str | None:
    """Path to the stackql binary: PATH first, then the copy bootstrap downloaded."""
    local = APPROOT / ("stackql.exe" if os.name == "nt" else "stackql")
    return shutil.which("stackql") or (str(local) if local.exists() else None)


def install() -> str:
    """Download the latest stackql release into the approot and return its path."""
    system = platform.system().lower()
    if system not in ("linux", "windows"):
        raise StackQLError(f"no automatic download for {system}, install stackql manually")
    arch = "arm64" if system == "linux" and platform.machine() == "aarch64" else "amd64"
    name = "stackql.exe" if system == "windows" else "stackql"
    # the release host rejects the default urllib user agent
    request = urllib.request.Request(
        DOWNLOAD_URL.format(system=system, arch=arch), headers={"User-Agent": "repo-warden"}
    )
    with urllib.request.urlopen(request) as response:
        zipfile.ZipFile(io.BytesIO(response.read())).extract(name, APPROOT)
    (APPROOT / name).chmod(0o755)
    return str(APPROOT / name)


def _run(sql: str, token_var: str) -> tuple[str, str]:
    """Run one statement and return (stdout, stderr)."""
    exe = binary()
    if exe is None:
        raise StackQLError("stackql binary not found, run `make bootstrap`")
    auth = json.dumps({PROVIDER: {"type": "bearer", "credentialsenvvar": token_var}})
    proc = subprocess.run(
        [exe, "exec", "--approot", str(APPROOT), "--auth", auth, "--output", "json", sql],
        capture_output=True,
        encoding="utf-8",
        check=False,
    )
    if proc.returncode != 0:
        raise StackQLError(proc.stderr.strip() or f"stackql exited with {proc.returncode}")
    return proc.stdout.strip(), proc.stderr.strip()


def execute(sql: str, token_var: str = READ_TOKEN_VAR) -> list[Row]:
    """Run one statement and return its rows.

    stackql exits 0 on failure, so an error is stderr output with nothing on stdout.
    """
    out, err = _run(sql, token_var)
    if err and not out:
        raise StackQLError(err)
    return json.loads(out) if out.startswith("[") else []


def provider_version() -> str:
    """Installed version of the github provider."""
    for row in execute("SHOW PROVIDERS"):
        if row["name"] == PROVIDER:
            return row["version"]
    raise StackQLError(f"{PROVIDER} provider not installed, run `make bootstrap`")


def pull_provider() -> str:
    """Pull the github provider from the registry and return the installed version.

    REGISTRY PULL reports success on stderr, so the result is confirmed with a read.
    """
    _run(f"REGISTRY PULL {PROVIDER}", READ_TOKEN_VAR)
    return provider_version()

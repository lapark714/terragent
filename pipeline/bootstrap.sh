#!/usr/bin/env bash
# Terragent imagery pipeline bootstrap (docs/ARCHITECTURE.md §10).
#
# Idempotent and safe to re-run (Naïve computers are replaced every 12 h):
#   1. find Python >= 3.12, or install one with uv (official installer, only if needed),
#   2. create pipeline/.venv and install requirements.txt (binary wheels only),
#   3. make `python -m terragent_pipeline.run` importable from any directory,
#   4. print "ready" on stdout (all progress goes to stderr).
#
# Usage: bash pipeline/bootstrap.sh [--dev]     (--dev also installs requirements-dev.txt for pytest)
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
VENV="$HERE/.venv"
PY="$VENV/bin/python"
STAMP="$VENV/.terragent-requirements"
REQ_ARGS=(-r "$HERE/requirements.txt")
if [[ "${1:-}" == "--dev" ]]; then REQ_ARGS+=(-r "$HERE/requirements-dev.txt"); fi

log() { echo "bootstrap: $*" >&2; }

sha256() { if command -v sha256sum >/dev/null 2>&1; then sha256sum | cut -d' ' -f1; else shasum -a 256 | cut -d' ' -f1; fi; }
wanted_stamp() { { cat "$HERE"/requirements*.txt; echo "${REQ_ARGS[*]}"; } | sha256; }

venv_works() { [[ -x "$PY" ]] && "$PY" -c 'import sys; sys.exit(sys.version_info < (3, 12))' 2>/dev/null; }
deps_work() { "$PY" -c 'import numpy, rasterio, PIL, h3, certifi' 2>/dev/null; }

# A system Python that can build a venv with pip (Debian/Ubuntu need python3-venv for ensurepip).
find_python() {
  local c
  for c in python3.13 python3.12 python3 python3.14; do
    if command -v "$c" >/dev/null 2>&1 &&
      "$c" -c 'import sys, venv, ensurepip; sys.exit(sys.version_info < (3, 12))' 2>/dev/null; then
      command -v "$c"
      return 0
    fi
  done
  return 1
}

find_uv() {
  local p
  if command -v uv >/dev/null 2>&1; then command -v uv; return 0; fi
  for p in "$HOME/.local/bin/uv" "$HOME/.cargo/bin/uv"; do
    if [[ -x "$p" ]]; then echo "$p"; return 0; fi
  done
  return 1
}

install_uv() {
  log "no Python >= 3.12 with venv support; installing uv from https://astral.sh/uv/install.sh"
  if command -v curl >/dev/null 2>&1; then
    curl -LsSf https://astral.sh/uv/install.sh | env UV_NO_MODIFY_PATH=1 sh >&2
  else
    wget -qO- https://astral.sh/uv/install.sh | env UV_NO_MODIFY_PATH=1 sh >&2
  fi
  find_uv
}

# `python -m terragent_pipeline.run` must work from any cwd: put pipeline/ on the venv's sys.path.
link_package() {
  local site
  site="$("$PY" -c 'import sysconfig; print(sysconfig.get_paths()["purelib"])')"
  echo "$HERE" >"$site/terragent_pipeline.pth"
}

if venv_works && deps_work && [[ "$(cat "$STAMP" 2>/dev/null)" == "$(wanted_stamp)" ]]; then
  link_package
  echo ready
  exit 0
fi

if ! venv_works; then
  rm -rf "$VENV"
  if PYTHON="$(find_python)"; then
    log "creating venv with $PYTHON ($("$PYTHON" --version 2>&1))"
    "$PYTHON" -m venv "$VENV"
  else
    UV="$(find_uv || install_uv)"
    log "creating venv with uv-managed Python 3.12"
    "$UV" venv --quiet --python 3.12 "$VENV" >&2
  fi
fi

log "installing requirements"
if UV="$(find_uv)"; then
  "$UV" pip install --quiet --python "$PY" --only-binary :all: "${REQ_ARGS[@]}" >&2
else
  "$PY" -m pip install --quiet --disable-pip-version-check --only-binary=:all: "${REQ_ARGS[@]}" >&2
fi

deps_work || { log "dependencies failed to import"; exit 1; }
wanted_stamp >"$STAMP"
link_package
echo ready

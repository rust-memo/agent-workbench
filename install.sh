#!/bin/sh
# Agent Workbench online installer (macOS / Linux).
#
#   curl -fsSL https://raw.githubusercontent.com/rust-memo/agent-workbench/main/install.sh | sh
#
# Downloads the standalone binary for your OS/arch from the latest GitHub
# release, verifies its SHA-256, and installs it to ~/.local/bin.
#
# Environment overrides:
#   AGENT_WORKBENCH_VERSION=v0.1.0      pin a release tag (default: latest)
#   AGENT_WORKBENCH_INSTALL_DIR=/path   install location (default: ~/.local/bin)
#   AGENT_WORKBENCH_SKILLS_DIR=/path    shipped skills location (default: ~/.agent-workbench/builtin-skills)
#   AGENT_WORKBENCH_SKIP_SKILLS=1       install binary only
#   AGENT_WORKBENCH_SKIP_CHECKSUM=1     install without SHA-256 verification (unsafe)
set -eu

REPO="${AGENT_WORKBENCH_REPO:-rust-memo/agent-workbench}"
BIN="agent-workbench"
ASSET_PREFIX="agent-workbench"

info() { printf '%s\n' "$*" >&2; }
err() {
  printf 'error: %s\n' "$*" >&2
  exit 1
}

# --- downloader (curl or wget) -------------------------------------------
if command -v curl >/dev/null 2>&1; then
  dl() { curl -fL --proto '=https' --tlsv1.2 -sS "$1" -o "$2"; }
  dl_stdout() { curl -fL --proto '=https' --tlsv1.2 -sS "$1"; }
elif command -v wget >/dev/null 2>&1; then
  dl() { wget -q -O "$2" "$1"; }
  dl_stdout() { wget -q -O- "$1"; }
else
  err "need either curl or wget installed"
fi

# --- detect platform ------------------------------------------------------
os=$(uname -s)
case "$os" in
  Darwin) os=darwin ;;
  Linux) os=linux ;;
  *) err "unsupported OS '$os' — on Windows use install.ps1 instead" ;;
esac

arch=$(uname -m)
case "$arch" in
  arm64 | aarch64) arch=arm64 ;;
  x86_64 | amd64) arch=x64 ;;
  *) err "unsupported architecture '$arch'" ;;
esac

asset="${ASSET_PREFIX}-${os}-${arch}"

requested_ver="${AGENT_WORKBENCH_VERSION:-latest}"
case "$requested_ver" in
  latest | v*) ;;
  [0-9]*) requested_ver="v${requested_ver}" ;;
esac

if [ "$requested_ver" = "latest" ]; then
  release_json=$(dl_stdout "https://api.github.com/repos/${REPO}/releases/latest") ||
    err "could not resolve the latest release for ${REPO}"
  ver=$(printf '%s\n' "$release_json" |
    sed -n 's/^[[:space:]]*"tag_name":[[:space:]]*"\([^"]*\)".*/\1/p' |
    head -n1)
  [ -n "$ver" ] || err "latest release metadata for ${REPO} has no tag_name"
  info "resolved latest release -> ${ver}"
else
  ver="$requested_ver"
fi

case "$ver" in
  '' | *[!A-Za-z0-9._-]*) err "invalid release tag '${ver}'" ;;
esac

base="https://github.com/${REPO}/releases/download/${ver}"

tmp=$(mktemp -d)
skills_stage=
skills_backup=
cleanup() {
  rm -rf "$tmp"
  [ -z "$skills_stage" ] || rm -rf "$skills_stage"
  [ -z "$skills_backup" ] || rm -rf "$skills_backup"
}
trap cleanup EXIT INT TERM

# --- download -------------------------------------------------------------
info "downloading ${asset} (${ver})..."
dl "${base}/${asset}" "${tmp}/${asset}" || err "download failed: ${base}/${asset}"
[ -s "${tmp}/${asset}" ] || err "downloaded asset is empty: ${base}/${asset}"

# --- verify checksum (required; fail-closed) -----------------------------
# A self-updating binary must not install an unverified download. Any failure
# to verify is fatal. Set AGENT_WORKBENCH_SKIP_CHECKSUM=1 to override (e.g. an
# air-gapped mirror you trust by other means).
if [ "${AGENT_WORKBENCH_SKIP_CHECKSUM:-}" = "1" ]; then
  info "warning: AGENT_WORKBENCH_SKIP_CHECKSUM=1 set — installing WITHOUT checksum verification"
else
  dl_stdout "${base}/SHA256SUMS" >"${tmp}/SHA256SUMS" 2>/dev/null ||
    err "could not download SHA256SUMS from ${base} — refusing to install an unverified binary (set AGENT_WORKBENCH_SKIP_CHECKSUM=1 to override)"
  [ -s "${tmp}/SHA256SUMS" ] ||
    err "downloaded SHA256SUMS is empty — refusing to install an unverified binary"
  want=$(awk -v a="$asset" '$2==a {print $1}' "${tmp}/SHA256SUMS" | head -n1)
  [ -n "$want" ] ||
    err "SHA256SUMS does not list ${asset} — refusing to install an unverified binary"
  if command -v sha256sum >/dev/null 2>&1; then
    got=$(sha256sum "${tmp}/${asset}" | awk '{print $1}')
  elif command -v shasum >/dev/null 2>&1; then
    got=$(shasum -a 256 "${tmp}/${asset}" | awk '{print $1}')
  else
    err "no sha256sum/shasum tool found — cannot verify the download (set AGENT_WORKBENCH_SKIP_CHECKSUM=1 to override)"
  fi
  [ "$got" = "$want" ] ||
    err "checksum mismatch for ${asset} (expected ${want}, got ${got})"
  info "checksum ok"
fi

# --- stage shipped skills from the exact binary release -----------------
# Resolve and stage skills before replacing the executable. This prevents a
# successful-looking update from mixing a release binary with skills from
# main (or leaving the previous release's skills behind after a download
# failure).
if [ "${AGENT_WORKBENCH_SKIP_SKILLS:-}" != "1" ]; then
  command -v tar >/dev/null 2>&1 ||
    err "tar is required to install shipped skills (set AGENT_WORKBENCH_SKIP_SKILLS=1 to install only the binary)"

  if [ -n "${AGENT_WORKBENCH_SKILLS_DIR:-}" ]; then
    skills_dir="$AGENT_WORKBENCH_SKILLS_DIR"
  else
    [ -n "${HOME:-}" ] || err "HOME is not set; set AGENT_WORKBENCH_SKILLS_DIR explicitly"
    skills_dir="$HOME/.agent-workbench/builtin-skills"
  fi

  archive_url="https://github.com/${REPO}/archive/refs/tags/${ver}.tar.gz"
  info "downloading shipped skills (${ver})..."
  dl "$archive_url" "${tmp}/source.tar.gz" || err "download failed: ${archive_url}"
  mkdir -p "${tmp}/source"
  tar -xzf "${tmp}/source.tar.gz" -C "${tmp}/source" ||
    err "failed to extract skills archive for ${ver}"
  skills_src=$(find "${tmp}/source" -type d -path "*/skills" | head -n1)
  [ -n "$skills_src" ] && [ -d "$skills_src" ] ||
    err "skills directory not found in the ${ver} source archive"

  mkdir -p "$(dirname "$skills_dir")"
  skills_stage="${skills_dir}.tmp.$$"
  rm -rf "$skills_stage"
  mkdir -p "$skills_stage"
  cp -R "$skills_src"/. "$skills_stage"/ || err "failed to stage shipped skills"
fi

# --- install --------------------------------------------------------------
if [ -n "${AGENT_WORKBENCH_INSTALL_DIR:-}" ]; then
  dir="$AGENT_WORKBENCH_INSTALL_DIR"
else
  [ -n "${HOME:-}" ] || err "HOME is not set; set AGENT_WORKBENCH_INSTALL_DIR explicitly"
  dir="$HOME/.local/bin"
fi

mkdir -p "$dir"
chmod 0755 "${tmp}/${asset}"
dest="${dir}/${BIN}"
staged="${dir}/.${BIN}.tmp.$$"
rm -f "$staged"
cp "${tmp}/${asset}" "$staged" || err "failed to stage binary in ${dir}"
chmod 0755 "$staged"
mv -f "$staged" "$dest" || err "failed to install binary to ${dest}"

# macOS: drop the quarantine attribute so Gatekeeper doesn't block the
# unsigned binary on first run.
if [ "$os" = darwin ] && command -v xattr >/dev/null 2>&1; then
  xattr -d com.apple.quarantine "$dest" 2>/dev/null || true
fi

info "installed ${BIN} -> ${dest}"

# --- install shipped skills ----------------------------------------------
if [ -n "$skills_stage" ]; then
  skills_backup="${skills_dir}.bak.$$"
  rm -rf "$skills_backup"
  if [ -e "$skills_dir" ]; then
    mv "$skills_dir" "$skills_backup" || err "failed to back up existing shipped skills"
  fi
  if ! mv "$skills_stage" "$skills_dir"; then
    [ ! -e "$skills_backup" ] || mv "$skills_backup" "$skills_dir"
    err "failed to install shipped skills"
  fi
  skills_stage=
  rm -rf "$skills_backup"
  skills_backup=
  info "installed shipped skills (${ver}) -> ${skills_dir}"
fi

case ":${PATH:-}:" in
  *":${dir}:"*) : ;;
  *) info "note: ${dir} is not on your PATH — add this to your shell profile:
    export PATH=\"${dir}:\$PATH\"" ;;
esac

"$dest" --version 2>/dev/null || info "run '${BIN} --help' to get started"

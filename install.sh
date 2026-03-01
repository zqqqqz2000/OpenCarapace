#!/usr/bin/env bash
set -euo pipefail

REPO="${OPENCARAPACE_REPO:-zqqqqz2000/OpenCarapace}"
INSTALL_DIR="${OPENCARAPACE_INSTALL_DIR:-/usr/local/bin}"
VERSION_INPUT="${OPENCARAPACE_VERSION:-latest}"

need_cmd() {
  if ! command -v "$1" >/dev/null 2>&1; then
    echo "error: required command not found: $1" >&2
    exit 1
  fi
}

need_cmd curl
need_cmd tar
need_cmd uname

resolve_tag() {
  if [[ "${VERSION_INPUT}" == "latest" ]]; then
    local latest
    latest="$(curl -fsSL "https://api.github.com/repos/${REPO}/releases/latest" | sed -n 's/.*"tag_name": *"\([^"]*\)".*/\1/p' | head -n 1)"
    if [[ -z "${latest}" ]]; then
      echo "error: failed to fetch latest release tag" >&2
      exit 1
    fi
    echo "${latest}"
    return
  fi

  if [[ "${VERSION_INPUT}" == v* ]]; then
    echo "${VERSION_INPUT}"
  else
    echo "v${VERSION_INPUT}"
  fi
}

map_os() {
  case "$(uname -s)" in
    Linux) echo "linux" ;;
    Darwin) echo "darwin" ;;
    *)
      echo "error: unsupported OS $(uname -s)" >&2
      exit 1
      ;;
  esac
}

map_arch() {
  case "$(uname -m)" in
    x86_64|amd64) echo "amd64" ;;
    arm64|aarch64) echo "arm64" ;;
    *)
      echo "error: unsupported architecture $(uname -m)" >&2
      exit 1
      ;;
  esac
}

TAG="$(resolve_tag)"
VERSION_NO_V="${TAG#v}"
OS="$(map_os)"
ARCH="$(map_arch)"
ARTIFACT="opencarapace_${VERSION_NO_V}_${OS}_${ARCH}.tar.gz"
URL="https://github.com/${REPO}/releases/download/${TAG}/${ARTIFACT}"

TMP_DIR="$(mktemp -d)"
trap 'rm -rf "${TMP_DIR}"' EXIT

echo "==> downloading ${URL}"
curl -fL "${URL}" -o "${TMP_DIR}/${ARTIFACT}"

echo "==> extracting ${ARTIFACT}"
tar -xzf "${TMP_DIR}/${ARTIFACT}" -C "${TMP_DIR}"

BIN_PATH="${TMP_DIR}/opencarapace"
if [[ ! -f "${BIN_PATH}" ]]; then
  echo "error: opencarapace binary not found in archive" >&2
  exit 1
fi
chmod +x "${BIN_PATH}"

if [[ -w "${INSTALL_DIR}" ]]; then
  install -m 0755 "${BIN_PATH}" "${INSTALL_DIR}/opencarapace"
else
  if command -v sudo >/dev/null 2>&1; then
    sudo install -m 0755 "${BIN_PATH}" "${INSTALL_DIR}/opencarapace"
  else
    echo "error: ${INSTALL_DIR} is not writable and sudo is unavailable." >&2
    echo "hint: OPENCARAPACE_INSTALL_DIR=\$HOME/.local/bin sh install.sh" >&2
    exit 1
  fi
fi

echo "==> installed: ${INSTALL_DIR}/opencarapace"
"${INSTALL_DIR}/opencarapace" --help | head -n 1

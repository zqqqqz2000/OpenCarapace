#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT_DIR"

if [[ -z "${TAG:-}" ]]; then
  if [[ -n "${VERSION:-}" ]]; then
    TAG="v${VERSION}"
  else
    VERSION_FROM_PKG="$(bun -e 'const pkg = JSON.parse(await Bun.file("package.json").text()); console.log(pkg.version);')"
    TAG="v${VERSION_FROM_PKG}"
  fi
fi

VERSION_NO_V="${TAG#v}"
REPO="${REPO:-${GITHUB_REPOSITORY:-zqqqqz2000/OpenCarapace}}"
CHECKSUMS_FILE="${CHECKSUMS_FILE:-dist/release/checksums.txt}"
OUTPUT="${OUTPUT:-}"

if [[ ! -f "${CHECKSUMS_FILE}" ]]; then
  echo "error: checksums file not found: ${CHECKSUMS_FILE}" >&2
  exit 1
fi

sha_for() {
  local artifact="$1"
  local sha
  sha="$(grep " ${artifact}$" "${CHECKSUMS_FILE}" | awk '{print $1}' | head -n 1)"
  if [[ -z "${sha}" ]]; then
    echo "error: checksum not found for ${artifact}" >&2
    exit 1
  fi
  echo "${sha}"
}

DARWIN_AMD64_ART="opencarapace_${VERSION_NO_V}_darwin_amd64.tar.gz"
DARWIN_ARM64_ART="opencarapace_${VERSION_NO_V}_darwin_arm64.tar.gz"
LINUX_AMD64_ART="opencarapace_${VERSION_NO_V}_linux_amd64.tar.gz"
LINUX_ARM64_ART="opencarapace_${VERSION_NO_V}_linux_arm64.tar.gz"

DARWIN_AMD64_SHA="$(sha_for "${DARWIN_AMD64_ART}")"
DARWIN_ARM64_SHA="$(sha_for "${DARWIN_ARM64_ART}")"
LINUX_AMD64_SHA="$(sha_for "${LINUX_AMD64_ART}")"
LINUX_ARM64_SHA="$(sha_for "${LINUX_ARM64_ART}")"

FORMULA_CONTENT="$(cat <<FORMULA
class Opencarapace < Formula
  desc "Channel-first orchestration layer for code agents"
  homepage "https://github.com/${REPO}"
  version "${VERSION_NO_V}"

  on_macos do
    if Hardware::CPU.arm?
      url "https://github.com/${REPO}/releases/download/${TAG}/${DARWIN_ARM64_ART}"
      sha256 "${DARWIN_ARM64_SHA}"
    else
      url "https://github.com/${REPO}/releases/download/${TAG}/${DARWIN_AMD64_ART}"
      sha256 "${DARWIN_AMD64_SHA}"
    end
  end

  on_linux do
    if Hardware::CPU.arm?
      url "https://github.com/${REPO}/releases/download/${TAG}/${LINUX_ARM64_ART}"
      sha256 "${LINUX_ARM64_SHA}"
    else
      url "https://github.com/${REPO}/releases/download/${TAG}/${LINUX_AMD64_ART}"
      sha256 "${LINUX_AMD64_SHA}"
    end
  end

  def install
    bin.install "opencarapace"
  end

  test do
    assert_match "OpenCarapace CLI", shell_output("#{bin}/opencarapace --help")
  end
end
FORMULA
)"

if [[ -n "${OUTPUT}" ]]; then
  mkdir -p "$(dirname "${OUTPUT}")"
  printf "%s\n" "${FORMULA_CONTENT}" > "${OUTPUT}"
  echo "formula written: ${OUTPUT}"
else
  printf "%s\n" "${FORMULA_CONTENT}"
fi

#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT_DIR"

if ! command -v bun >/dev/null 2>&1; then
  echo "error: bun is required" >&2
  exit 1
fi
if ! command -v nfpm >/dev/null 2>&1; then
  echo "error: nfpm is required to build deb/arch packages" >&2
  exit 1
fi

if [[ -z "${VERSION:-}" ]]; then
  VERSION="$(bun -e 'const pkg = JSON.parse(await Bun.file("package.json").text()); console.log(pkg.version);')"
fi

TAG="${TAG:-v${VERSION}}"
VERSION_NO_V="${TAG#v}"
DIST_DIR="${DIST_DIR:-dist/release}"
STAGE_ROOT="${DIST_DIR}/stage"
REPO="${REPO:-${GITHUB_REPOSITORY:-zqqqqz2000/OpenCarapace}}"

rm -rf "$DIST_DIR"
mkdir -p "$DIST_DIR" "$STAGE_ROOT"

# target_bun:os:arch
TARGETS=(
  "bun-linux-x64:linux:amd64"
  "bun-linux-arm64:linux:arm64"
  "bun-darwin-x64:darwin:amd64"
  "bun-darwin-arm64:darwin:arm64"
)

for target in "${TARGETS[@]}"; do
  IFS=":" read -r bun_target os arch <<<"$target"
  stage_dir="${STAGE_ROOT}/${os}_${arch}"
  mkdir -p "$stage_dir"

  echo "==> compiling ${bun_target}"
  bun build src/cli/opencarapace.ts \
    --compile \
    --target="${bun_target}" \
    --outfile "${stage_dir}/opencarapace"
  chmod +x "${stage_dir}/opencarapace"

  archive="opencarapace_${VERSION_NO_V}_${os}_${arch}.tar.gz"
  echo "==> packaging ${archive}"
  tar -C "$stage_dir" -czf "${DIST_DIR}/${archive}" opencarapace

done

for arch in amd64 arm64; do
  linux_stage="${STAGE_ROOT}/linux_${arch}"
  cfg_file="${DIST_DIR}/nfpm.${arch}.yaml"

  cat >"${cfg_file}" <<NFPM
name: opencarapace
arch: ${arch}
platform: linux
version: ${VERSION_NO_V}
release: 1
section: utils
priority: optional
maintainer: OpenCarapace Maintainers <maintainers@open-carapace.local>
description: Channel-first orchestration layer for code agents.
homepage: https://github.com/${REPO}
contents:
  - src: ${linux_stage}/opencarapace
    dst: /usr/bin/opencarapace
    file_info:
      mode: 0755
NFPM

  echo "==> packaging deb (${arch})"
  nfpm package \
    --packager deb \
    --config "${cfg_file}" \
    --target "${DIST_DIR}/opencarapace_${VERSION_NO_V}_linux_${arch}.deb"

  echo "==> packaging pacman (${arch})"
  nfpm package \
    --packager archlinux \
    --config "${cfg_file}" \
    --target "${DIST_DIR}/opencarapace_${VERSION_NO_V}_linux_${arch}.pkg.tar.zst"

done

rm -f "${DIST_DIR}"/nfpm.*.yaml
(
  cd "$DIST_DIR"
  shasum -a 256 *.tar.gz *.deb *.pkg.tar.zst > checksums.txt
)

echo "==> artifacts generated in ${DIST_DIR}"

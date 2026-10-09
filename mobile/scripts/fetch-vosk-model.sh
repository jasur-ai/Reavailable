#!/usr/bin/env bash
# Downloads the small English Vosk model used for offline voice commands and installs it as
# mobile/assets/model-en-us (the folder name must start with "model-" for react-native-vosk).
#
# Usage:
#   scripts/fetch-vosk-model.sh                 # from the default Vosk URL
#   VOSK_MODEL_URL=file:///path/model.zip scripts/fetch-vosk-model.sh   # from a local archive
#   scripts/fetch-vosk-model.sh --force         # replace an existing model
#   VOSK_MODEL_SHA256=<hex> scripts/fetch-vosk-model.sh  # refuse the archive unless its SHA-256 matches
#
# The model is about 40 MB and is not committed to git (see .gitignore). No checksum is built in,
# because it could not be verified from the development sandbox. Set VOSK_MODEL_SHA256 once the value
# has been checked against the official release.
set -euo pipefail

MODEL_ARCHIVE_DIR="vosk-model-small-en-us-0.15"
DEFAULT_URL="https://alphacephei.com/kaldi/models/${MODEL_ARCHIVE_DIR}.zip"
URL="${VOSK_MODEL_URL:-$DEFAULT_URL}"
EXPECTED_SHA256="${VOSK_MODEL_SHA256:-}"

MOBILE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DEST="${MOBILE_DIR}/assets/model-en-us"

force=false
if [[ "${1:-}" == "--force" ]]; then
  force=true
fi

if [[ -f "${DEST}/am/final.mdl" && "$force" != true ]]; then
  echo "Model already present at ${DEST}. Use --force to replace it."
  exit 0
fi

for tool in curl unzip; do
  if ! command -v "$tool" >/dev/null 2>&1; then
    echo "error: '$tool' is required but was not found on PATH." >&2
    exit 1
  fi
done

# sha256sum on Linux, shasum on macOS.
sha256_of() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$1" | awk '{print $1}'
  elif command -v shasum >/dev/null 2>&1; then
    shasum -a 256 "$1" | awk '{print $1}'
  else
    echo "error: sha256sum or shasum is required." >&2
    exit 1
  fi
}

workdir="$(mktemp -d)"
trap 'rm -rf "$workdir"' EXIT

echo "Downloading ${URL}"
curl --fail --location --retry 3 --silent --show-error --output "${workdir}/model.zip" "$URL"

actual_sha256="$(sha256_of "${workdir}/model.zip")"
echo "Archive SHA-256: ${actual_sha256}"
if [[ -n "$EXPECTED_SHA256" ]]; then
  if [[ "$actual_sha256" != "$EXPECTED_SHA256" ]]; then
    echo "error: SHA-256 mismatch (expected ${EXPECTED_SHA256}). Not installing; the existing model is unchanged." >&2
    exit 1
  fi
else
  echo "warning: VOSK_MODEL_SHA256 is not set, so the archive was not checked against a known checksum." >&2
fi

unzip -q "${workdir}/model.zip" -d "${workdir}/extracted"

# Sanity checks: the archive must contain the expected folder with an acoustic model.
if [[ ! -f "${workdir}/extracted/${MODEL_ARCHIVE_DIR}/am/final.mdl" ]]; then
  echo "error: the archive does not contain ${MODEL_ARCHIVE_DIR}/am/final.mdl. Not installing." >&2
  exit 1
fi

rm -rf "$DEST"
mkdir -p "$(dirname "$DEST")"
mv "${workdir}/extracted/${MODEL_ARCHIVE_DIR}" "$DEST"
echo "Installed the offline English model at ${DEST}"

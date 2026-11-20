#!/usr/bin/env bash
# Fetch the exact speech engine and Whisper Tiny model used by KothaNote.
#
# The AAR and model are large binary files, so they are not committed to git.
# This script is used by CI and can be run locally before the first build:
#
#   bash scripts/fetch-speech.sh
#
# Every download is SHA-256 verified. Existing files with the right hash are
# left untouched, so repeated runs are cheap.

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

AAR_URL="https://github.com/k2-fsa/sherpa-onnx/releases/download/v2.0.2/sherpa-onnx-2.0.2.aar"
AAR_SHA256="6420cfb86c2ef8462dadd77b2202b7430487bdfb2bc715e9ce2864871209a80e"

MODEL_URL="https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/sherpa-onnx-whisper-tiny.tar.bz2"
MODEL_SHA256="c46116994e539aa165266d96b325252728429c12535eb9d8b6a2b10f129e66b1"

ENCODER_SHA256="d24fb083ae3b1041fc24e97971d60e280c9342201fbb67b0ab428a8b4a51a434"
DECODER_SHA256="d2fece8dd42771f1df975c6c0445770d0c292bf7547c2cae04a6c0cc57540925"
TOKENS_SHA256="b34b360dbb493e781e479794586d661700670d65564001f23024971d1f2fa126"

AAR="$ROOT/app/libs/sherpa-onnx-2.0.2.aar"
MODEL_DIR="$ROOT/app/src/main/assets/asr"
MODEL_MEMBERS="sherpa-onnx-whisper-tiny/tiny-encoder.int8.onnx sherpa-onnx-whisper-tiny/tiny-decoder.int8.onnx sherpa-onnx-whisper-tiny/tiny-tokens.txt"

hash_file() {
    if command -v sha256sum >/dev/null 2>&1; then
        sha256sum "$1" | awk '{print $1}'
    elif command -v shasum >/dev/null 2>&1; then
        shasum -a 256 "$1" | awk '{print $1}'
    else
        echo "Neither sha256sum nor shasum is available." >&2
        exit 1
    fi
}

verify() {
    local file="$1" expected="$2" label="$3"
    if [ ! -f "$file" ]; then
        echo "$label is missing: $file" >&2
        return 1
    fi
    local actual
    actual="$(hash_file "$file")"
    if [ "$actual" != "$expected" ]; then
        echo "$label has the wrong SHA-256." >&2
        echo "  file:     $file" >&2
        echo "  expected: $expected" >&2
        echo "  actual:   $actual" >&2
        return 1
    fi
    return 0
}

download() {
    local url="$1" destination="$2"
    echo "Downloading $url"
    curl -fL --retry 5 --retry-delay 3 --connect-timeout 20 \
        --output "$destination" "$url"
}

model_ready() {
    verify "$MODEL_DIR/tiny-encoder.int8.onnx" "$ENCODER_SHA256" "Whisper encoder" &&
        verify "$MODEL_DIR/tiny-decoder.int8.onnx" "$DECODER_SHA256" "Whisper decoder" &&
        verify "$MODEL_DIR/tiny-tokens.txt" "$TOKENS_SHA256" "Whisper tokens"
}

aar_ready() {
    verify "$AAR" "$AAR_SHA256" "sherpa-onnx AAR"
}

if ! command -v curl >/dev/null 2>&1; then
    echo "curl is required to download the speech engine." >&2
    exit 1
fi

if aar_ready && model_ready; then
    echo "Speech engine and Whisper Tiny model are already present and verified."
    exit 0
fi

TMP="$(mktemp -d "${TMPDIR:-/tmp}/kotha-speech.XXXXXX")"
cleanup() {
    rm -rf "$TMP"
}
trap cleanup EXIT

mkdir -p "$ROOT/app/libs" "$MODEL_DIR"

if ! aar_ready; then
    download "$AAR_URL" "$TMP/sherpa-onnx-2.0.2.aar"
    verify "$TMP/sherpa-onnx-2.0.2.aar" "$AAR_SHA256" "sherpa-onnx AAR"
    mv "$TMP/sherpa-onnx-2.0.2.aar" "$AAR"
    verify "$AAR" "$AAR_SHA256" "sherpa-onnx AAR"
    echo "Installed $AAR"
fi

if ! model_ready; then
    download "$MODEL_URL" "$TMP/sherpa-onnx-whisper-tiny.tar.bz2"
    verify "$TMP/sherpa-onnx-whisper-tiny.tar.bz2" "$MODEL_SHA256" "Whisper Tiny archive"
    # Only the three int8 files are needed; the archive also contains larger
    # float models and test audio that the app never uses.
    # shellcheck disable=SC2086
    tar -xjf "$TMP/sherpa-onnx-whisper-tiny.tar.bz2" -C "$TMP" $MODEL_MEMBERS
    cp "$TMP/sherpa-onnx-whisper-tiny/tiny-encoder.int8.onnx" "$MODEL_DIR/"
    cp "$TMP/sherpa-onnx-whisper-tiny/tiny-decoder.int8.onnx" "$MODEL_DIR/"
    cp "$TMP/sherpa-onnx-whisper-tiny/tiny-tokens.txt" "$MODEL_DIR/"
    model_ready
    echo "Installed the Whisper Tiny int8 model in $MODEL_DIR"
fi

echo "Speech assets are ready."

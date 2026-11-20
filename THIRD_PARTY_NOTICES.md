# Third-party notices

KothaNote includes the following third-party components. They are bundled so the app can work
fully offline. No component sends data over the network.

## sherpa-onnx

- Version: 2.0.2
- Copyright: Xiaomi Corporation and sherpa-onnx contributors
- License: Apache License 2.0
- Source: https://github.com/k2-fsa/sherpa-onnx
- License text: https://github.com/k2-fsa/sherpa-onnx/blob/master/LICENSE

The Android AAR (`app/libs/sherpa-onnx-2.0.2.aar`) contains the sherpa-onnx JNI libraries and
ONNX Runtime native libraries for `arm64-v8a` and `armeabi-v7a`.

## ONNX Runtime

- Copyright: Microsoft Corporation and ONNX Runtime contributors
- License: MIT
- Source: https://github.com/microsoft/onnxruntime
- License text: https://github.com/microsoft/onnxruntime/blob/main/LICENSE

ONNX Runtime is distributed inside the sherpa-onnx AAR.

## OpenAI Whisper Tiny (int8)

- Model: `whisper-tiny` multilingual, quantized to int8
- Copyright: OpenAI and Whisper contributors
- License: MIT
- Source: https://github.com/openai/whisper
- Model files: https://github.com/k2-fsa/sherpa-onnx/releases/tag/asr-models
  (`sherpa-onnx-whisper-tiny.tar.bz2`)

The app bundles only `tiny-encoder.int8.onnx`, `tiny-decoder.int8.onnx`, and `tiny-tokens.txt`
from the official sherpa-onnx model archive.

## Poppins

- Copyright: Indian Type Foundry
- License: SIL Open Font License 1.1
- Source: https://github.com/itfoundry/Poppins

The app bundles the Latin WOFF2 subsets in `app/src/main/assets/fonts/`.

## Hind Siliguri

- Copyright: Indian Type Foundry
- License: SIL Open Font License 1.1
- Source: https://github.com/itfoundry/hind-siliguri

The app bundles the Bengali and Latin WOFF2 subsets in `app/src/main/assets/fonts/`.

## AndroidX / Kotlin standard library

The build uses the Kotlin standard library (`org.jetbrains.kotlin:kotlin-stdlib`) at runtime
because the sherpa-onnx AAR is written in Kotlin.

- Kotlin standard library — Apache License 2.0
- Source: https://github.com/JetBrains/kotlin

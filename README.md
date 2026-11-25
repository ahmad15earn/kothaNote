# KothaNote

A quiet voice-notes app. One big mic button, no account, no clutter — speak now, read a clean
transcript when you are online. Swipe up on the mic to type instead.

- **Android 7.0+** (`minSdk 24`)
- **Real microphone recording** with pause and resume
- **Record first, transcribe later** — audio is saved instantly; transcripts are fetched over
  Wi-Fi or mobile data, and finish on their own when the connection returns
- **Google Gemini transcription** (Fast or Best quality) with a free key you paste once
- **Type mode** — swipe up on the mic to write a note by hand
- **Playback** with seek, 1× / 1.5× / 2× speed, and progress
- **Append** a new recording to an existing note
- **Delete with Undo**, category filters, automatic titles, copy and share
- **Export all text** to `Downloads/KothaNote/`
- **No account, no KothaNote server** — only Google Gemini receives a recording, and only when
  cloud transcription is set up
- Light theme only — Poppins for English, Hind Siliguri for বাংলা
- White background, ink `#2B2B2B`, muted `#8B8B88`, coral `#FF5A3C`

A fresh install starts with **no sample notes and no placeholder transcripts**.

## Download the APK

1. Open the **Releases** tab of this repository.
2. Download **`KothaNote-debug.apk`** from the **latest** release.
3. Install it on the phone (allow "Install unknown apps" for the browser or file manager).
4. Optionally compare the download with **`KothaNote-debug.apk.sha256`**.

The release asset is replaced on every successful build from `main`, so the same link always
gives the newest APK. The APK also carries the on-device Whisper model, so it is about **124 MB**.

The workflow builds on **every push** and can also be started manually from
**Actions → Build Android APK → Run workflow**. Run artifacts are best-effort because the
account's Actions artifact storage can be full; the release asset is the primary download.

> The APK is **debug-signed** with a stable key committed in this repository. That keeps future
> sideloaded updates installable over each other. If you have the old demo APK installed, uninstall
> it once, because that build used a different key. This is not a Play Store release.

## What works

- Splash, Home, Note detail, Settings, and the bottom-sheet Recording screen
- A name in Settings; the home screen becomes **Notes of Ahmad** (or the name you type)
- A seven-day usage chart in Settings, built from the days you saved a note
- Voice-language switching by swiping the mic pill, or from Settings:
  **বাংলা**, **English**, **Auto** (let Gemini detect the language)
- Swipe **up** on the mic for **Type a note**; the phone keyboard handles Bangla or English
- Real 16-bit mono WAV capture at 16 kHz (or the closest rate the phone supports)
- Pause/resume without inserting silence into the recording
- Live level meter driven by microphone amplitude
- Nothing is transcribed at record time. The note appears immediately as **Waiting for internet**
- When online and a Gemini key is saved, the queue sends the audio, shows progress, then fills
  in the transcript. A note saved offline starts by itself when the connection returns or when
  the app is opened again
- Pause-aware chunks: audio is cut only at pauses of 0.9 s or more, so each natural break becomes
  a paragraph; long recordings are split into 6-minute pieces for Gemini
- Audio-only notes are kept when a transcript cannot be made; tap **Transcribe now** to retry
- 44-bar seekable player, playback speed, copy, native Android share
- Category changes, appending a new recording to an existing note
- Toast messages, discard dialog, reduced-motion support, hardware back handling
- Notes and metadata survive a restart; audio files are stored in app-private storage
- Export writes a UTF-8 text file through MediaStore on Android 10+ and through the legacy
  Downloads permission on Android 7–9

## Cloud transcription

Open **Settings → Cloud transcription**, tap **Get a free Gemini key**, and paste the key. The key
is kept in app-private storage on the phone and never appears in the UI again. Choose **Fast**
(`gemini-2.5-flash`, generous free tier) or **Best quality** (`gemini-2.5-pro`, slower).

Only the audio of a note you recorded is sent, only while a transcript is being made. There is no
KothaNote server and no account. Without a key nothing leaves the phone, and recordings stay
waiting until one is added.

The queue runs while the app is open (or when it comes back to the foreground). If Android closes
the app, pending notes resume on the next launch with internet.

## Permissions

| Permission | Why |
| --- | --- |
| `RECORD_AUDIO` | Record voice notes |
| `INTERNET` | Send a recording to Google Gemini for a transcript |
| `ACCESS_NETWORK_STATE` | Notice when Wi-Fi or data comes back and start the queue |
| `WRITE_EXTERNAL_STORAGE` (`maxSdkVersion=28`) | Save exported text on Android 7–9 only |
| `VIBRATE` | Short haptic feedback |

The app still has **no KothaNote server and no analytics**. Nothing is uploaded until you add a
Gemini key and a recording is waiting for a transcript.

## Build locally

Requirements: JDK 17 and Android SDK 34.

The speech engine and model are large binaries and are **not committed**. Fetch and verify them
once:

```bash
bash scripts/fetch-speech.sh
```

On Windows PowerShell:

```powershell
powershell -ExecutionPolicy Bypass -File scripts\fetch-speech.ps1
```

Both scripts download:

- `sherpa-onnx-2.0.2.aar` from the official sherpa-onnx release
- `sherpa-onnx-whisper-tiny.tar.bz2`, extracting only the int8 encoder, decoder, and tokens

Every file is checked against a pinned SHA-256 before it is used. Existing verified files are
kept, so repeated runs do not download again.

Then build:

```bash
./gradlew :app:assembleDebug
```

On Windows:

```powershell
.\gradlew.bat :app:assembleDebug
```

The APK is written to:

```text
app/build/outputs/apk/debug/app-debug.apk
```

The build targets `arm64-v8a` and `armeabi-v7a` only. Emulator x86 libraries are excluded to keep
the download manageable.

## Project structure

```text
app/src/main/
├── AndroidManifest.xml             # microphone + legacy export permission; no INTERNET
├── java/com/kothanote/app/
│   └── MainActivity.java           # WebView shell, recorder, Whisper bridge, playback, export
├── assets/
│   ├── index.html                  # offline UI shell
│   ├── app.js                      # real recording/transcription/player UI logic
│   ├── bubble.png                  # hand-drawn speech bubble artwork
│   ├── asr/                        # fetched Whisper Tiny int8 model (not committed)
│   └── fonts/                      # bundled Poppins + Hind Siliguri WOFF2
└── res/                            # light theme, launcher icons, splash
```

The shell serves bundled files from `https://app.local/` by intercepting requests inside
`MainActivity`, so there is no network traffic. Native methods provide recording, transcription,
playback, clipboard, the Android share sheet, haptics, reduced-motion detection, and hardware-back
routing.

## CI and releases

`.github/workflows/build-apk.yml`:

1. Restores cached AAR/model files, or downloads them with `scripts/fetch-speech.sh`.
2. Verifies every SHA-256.
3. Builds the debug APK and checks that the model and both phone ABIs are present.
4. Uploads a run artifact when storage allows.
5. Publishes `KothaNote-debug.apk` and its checksum to the `latest` release when the branch is
   `main`.

## Third-party components

- **sherpa-onnx 2.0.2** — Apache-2.0
- **ONNX Runtime** (bundled by sherpa-onnx) — MIT
- **Whisper Tiny int8 model** — MIT (OpenAI Whisper)
- **Poppins** — SIL Open Font License 1.1
- **Hind Siliguri** — SIL Open Font License 1.1

See [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) for links and license details.

## License

MIT for the KothaNote source code. The speech-bubble artwork is included with the project for
this app.

# KothaNote

A quiet, offline voice-notes app. One big mic button, no account, no typing, no internet.

- **Android 7.0+** (`minSdk 24`)
- **No internet permission** — the UI, fonts, and artwork are bundled in the APK
- **No account, no server** — notes stay on the phone
- **Light theme only** — Poppins for English, Hind Siliguri for বাংলা
- White background, ink `#2B2B2B`, muted `#8B8B88`, coral `#FF5A3C`

## Download the APK

1. Open the **Releases** tab of this repository (or click **Releases → KothaNote latest APK**).
2. Download **`KothaNote-debug.apk`** from the latest release.
3. Install it on the phone (allow "Install unknown apps" for the browser/file manager you use).

The release asset is replaced on every successful build, so the same link always gives the newest APK.

The workflow builds on **every push** and can also be started manually from **Actions → Build Android APK → Run workflow**. When the account's Actions artifact storage is available, the same APK is also attached to the run as the **KothaNote-APK** artifact.

## What is in this demo

The visual app is complete:

- Splash, Home, Note detail, Settings, and the bottom-sheet Recording screen
- Voice-language switching by swiping the mic pill (বাংলা → Auto, Auto stays Auto, left → English)
- Category filters and automatic titles from the first five transcript words
- "Today" / "Earlier" grouping, fresh-note coral flash, delete with Undo
- 44-bar seekable player UI, playback speed, copy, native Android share
- Category changes, adding more text/duration to an existing note
- Toast messages, discard dialog, reduced-motion support, hardware back handling
- Notes are persisted locally in the WebView's on-device storage, so they survive a restart

As requested for this demo, **recording, transcription, and audio playback are simulated**. A sample sentence appears word by word; the player moves through a generated waveform and time but does not produce sound. No microphone is accessed and no audio is stored yet.

## Build locally

Requirements: JDK 17 and Android SDK 34.

```bash
./gradlew :app:assembleDebug
```

The APK is written to:

```text
app/build/outputs/apk/debug/app-debug.apk
```

On Windows:

```powershell
.\gradlew.bat :app:assembleDebug
```

## Project structure

```text
app/src/main/
├── AndroidManifest.xml             # VIBRATE only; no INTERNET permission
├── java/com/kothanote/app/
│   └── MainActivity.java           # WebView shell, local asset server, native bridge
├── assets/
│   ├── index.html                  # complete offline UI and demo logic
│   ├── bubble.png                  # hand-drawn speech bubble artwork
│   └── fonts/                      # bundled Poppins + Hind Siliguri WOFF2
└── res/                            # light theme, launcher icons, splash
```

The shell serves the bundled UI from `https://app.local/` by intercepting requests inside `MainActivity`, so there is no network traffic. Native methods provide clipboard, the Android share sheet, 12 ms haptics, reduced-motion detection, and hardware-back routing.

## Going from demo to real voice notes

1. Add `RECORD_AUDIO` and runtime microphone permission; record with `MediaRecorder`/`AudioRecord`.
2. Store notes in SQLite/Room with `id`, `category`, `createdAt`, `durationSeconds`, `transcript`, `audioPath`.
3. Run an offline speech-to-text model (e.g. Whisper/Vosk) and stream partial words into the live transcript.
4. Feed real microphone amplitude into the 36-bar waveform.
5. Implement `Export all notes` with the Storage Access Framework or MediaStore Downloads.
6. Replace the generated detail waveform with peaks extracted from the recorded audio file.

## License

MIT. The speech-bubble artwork is included with the project for this app.

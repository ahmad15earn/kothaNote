package com.kothanote.app;

import android.Manifest;
import android.app.Activity;
import android.content.ClipData;
import android.content.ClipboardManager;
import android.content.ContentResolver;
import android.content.ContentValues;
import android.content.Context;
import android.content.Intent;
import android.content.pm.ApplicationInfo;
import android.content.pm.PackageManager;
import android.graphics.Color;
import android.media.AudioFormat;
import android.media.AudioRecord;
import android.media.MediaPlayer;
import android.media.MediaRecorder;
import android.media.MediaScannerConnection;
import android.media.PlaybackParams;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.os.Environment;
import android.os.Handler;
import android.os.Looper;
import android.os.VibrationEffect;
import android.os.Vibrator;
import android.provider.MediaStore;
import android.provider.Settings;
import android.view.View;
import android.view.ViewGroup;
import android.view.Window;
import android.view.WindowManager;
import android.webkit.JavascriptInterface;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;

import com.k2fsa.sherpa.onnx.OfflineModelConfig;
import com.k2fsa.sherpa.onnx.OfflineRecognizer;
import com.k2fsa.sherpa.onnx.OfflineRecognizerConfig;
import com.k2fsa.sherpa.onnx.OfflineRecognizerResult;
import com.k2fsa.sherpa.onnx.OfflineStream;
import com.k2fsa.sherpa.onnx.OfflineWhisperModelConfig;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.BufferedInputStream;
import java.io.BufferedOutputStream;
import java.io.ByteArrayInputStream;
import java.io.DataInputStream;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.io.RandomAccessFile;
import java.nio.ByteBuffer;
import java.nio.ByteOrder;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.HashSet;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Set;
import java.util.UUID;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

public class MainActivity extends Activity {

    private static final String LOCAL_HOST = "app.local";
    private static final String START_URL = "https://" + LOCAL_HOST + "/index.html";
    private static final int REQ_MIC = 9101;
    private static final int REQ_STORAGE = 9102;

    private WebView webView;
    private File recordingsDir;
    private final Handler mainHandler = new Handler(Looper.getMainLooper());
    private ExecutorService speechExecutor;
    private ExecutorService ioExecutor;
    private SpeechEngine speechEngine;

    private final Object recorderLock = new Object();
    private Recorder recorder;

    private MediaPlayer player;
    private String playerFile;
    private volatile boolean playerPrepared;
    private volatile boolean playerPlaying;
    private volatile int playerPositionMs;
    private volatile int playerDurationMs;
    private int pendingSeekMs = -1;
    private float playbackSpeed = 1f;
    private boolean pendingPlay = false;
    private boolean keepAwake = false;

    private String pendingExportContent;
    private String pendingExportName;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);

        Window window = getWindow();
        window.setStatusBarColor(Color.WHITE);
        window.setNavigationBarColor(Color.WHITE);
        int ui = View.SYSTEM_UI_FLAG_LIGHT_STATUS_BAR;
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            ui |= View.SYSTEM_UI_FLAG_LIGHT_NAVIGATION_BAR;
        }
        window.getDecorView().setSystemUiVisibility(ui);
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
            window.setNavigationBarDividerColor(Color.WHITE);
        }
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            window.setStatusBarContrastEnforced(false);
            window.setNavigationBarContrastEnforced(false);
        }

        recordingsDir = new File(getFilesDir(), "recordings");
        if (!recordingsDir.exists() && !recordingsDir.mkdirs()) {
            // A missing folder is handled gracefully by startRecording().
        }
        speechExecutor = Executors.newSingleThreadExecutor();
        ioExecutor = Executors.newSingleThreadExecutor();
        speechEngine = new SpeechEngine();

        webView = new WebView(this);
        webView.setLayoutParams(new ViewGroup.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT,
                ViewGroup.LayoutParams.MATCH_PARENT));
        webView.setBackgroundColor(Color.WHITE);
        webView.setOverScrollMode(View.OVER_SCROLL_NEVER);
        webView.setVerticalScrollBarEnabled(false);
        webView.setHorizontalScrollBarEnabled(false);

        WebSettings settings = webView.getSettings();
        settings.setJavaScriptEnabled(true);
        settings.setDomStorageEnabled(true);
        settings.setDatabaseEnabled(true);
        settings.setAllowFileAccess(false);
        settings.setAllowContentAccess(false);
        settings.setSupportZoom(false);
        settings.setBuiltInZoomControls(false);
        settings.setDisplayZoomControls(false);
        settings.setTextZoom(100);
        settings.setJavaScriptCanOpenWindowsAutomatically(false);
        settings.setSupportMultipleWindows(false);
        settings.setGeolocationEnabled(false);
        settings.setSaveFormData(false);
        settings.setMediaPlaybackRequiresUserGesture(false);
        settings.setCacheMode(WebSettings.LOAD_DEFAULT);
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            settings.setSafeBrowsingEnabled(false);
        }
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            settings.setForceDark(WebSettings.FORCE_DARK_OFF);
        }
        if (Build.VERSION.SDK_INT >= 33) {
            settings.setAlgorithmicDarkeningAllowed(false);
        }

        WebView.setWebContentsDebuggingEnabled(
                (getApplicationInfo().flags & ApplicationInfo.FLAG_DEBUGGABLE) != 0);

        webView.addJavascriptInterface(new NativeBridge(), "Android");
        webView.setWebViewClient(new LocalClient());
        setContentView(webView);
        webView.loadUrl(START_URL);
    }

    private boolean isLocalUrl(Uri uri) {
        return uri != null
                && "https".equals(uri.getScheme())
                && LOCAL_HOST.equals(uri.getHost());
    }

    private WebResourceResponse notFound() {
        WebResourceResponse response = new WebResourceResponse(
                "text/plain",
                "UTF-8",
                new ByteArrayInputStream("Not found".getBytes(StandardCharsets.UTF_8)));
        response.setStatusCodeAndReasonPhrase(404, "Not Found");
        return response;
    }

    private WebResourceResponse serveAsset(String path) {
        if (path == null || path.isEmpty() || "/".equals(path)) {
            path = "/index.html";
        }
        String assetPath = path.startsWith("/") ? path.substring(1) : path;
        if (assetPath.contains("..")) {
            return notFound();
        }

        String mime = mimeFor(assetPath);
        String encoding = (mime.startsWith("text/") || mime.contains("javascript")) ? "UTF-8" : null;
        try {
            InputStream stream = getAssets().open(assetPath);
            WebResourceResponse response = new WebResourceResponse(mime, encoding, stream);
            Map<String, String> headers = new HashMap<>();
            headers.put("Cache-Control", "no-cache");
            headers.put("Access-Control-Allow-Origin", "*");
            response.setResponseHeaders(headers);
            return response;
        } catch (IOException e) {
            return notFound();
        }
    }

    private static String mimeFor(String path) {
        String lower = path.toLowerCase(Locale.US);
        if (lower.endsWith(".html")) return "text/html";
        if (lower.endsWith(".css")) return "text/css";
        if (lower.endsWith(".js")) return "application/javascript";
        if (lower.endsWith(".json")) return "application/json";
        if (lower.endsWith(".png")) return "image/png";
        if (lower.endsWith(".jpg") || lower.endsWith(".jpeg")) return "image/jpeg";
        if (lower.endsWith(".svg")) return "image/svg+xml";
        if (lower.endsWith(".woff2")) return "font/woff2";
        if (lower.endsWith(".woff")) return "font/woff";
        if (lower.endsWith(".onnx")) return "application/octet-stream";
        if (lower.endsWith(".txt")) return "text/plain";
        return "application/octet-stream";
    }

    private final class LocalClient extends WebViewClient {

        @Override
        public WebResourceResponse shouldInterceptRequest(WebView view, WebResourceRequest request) {
            Uri uri = request.getUrl();
            if (isLocalUrl(uri)) {
                return serveAsset(uri.getPath());
            }
            return null;
        }

        @Override
        public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
            return !isLocalUrl(request.getUrl());
        }

        @SuppressWarnings("deprecation")
        @Override
        public boolean shouldOverrideUrlLoading(WebView view, String url) {
            return !isLocalUrl(Uri.parse(url));
        }

        @Override
        public void onPageFinished(WebView view, String url) {
            super.onPageFinished(view, url);
            view.evaluateJavascript(
                    "document.documentElement.classList.add('native');", null);
        }
    }

    private void emit(final String javascript) {
        mainHandler.post(() -> {
            if (webView != null) {
                webView.evaluateJavascript(javascript, null);
            }
        });
    }

    private void emitCallback(String name, String json) {
        emit("window." + name + " && window." + name + "(" + json + ");");
    }

    private void setKeepAwake(boolean on) {
        if (keepAwake == on) return;
        keepAwake = on;
        runOnUiThread(() -> {
            try {
                if (on) {
                    getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
                } else {
                    getWindow().clearFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
                }
            } catch (Exception ignored) {
            }
        });
    }

    private File resolveAudio(String name) {
        if (name == null) return null;
        String value = name.trim();
        if (!value.matches("^[A-Za-z0-9._-]{1,90}\\.wav$")) return null;
        if (value.contains("..")) return null;
        return new File(recordingsDir, value);
    }

    private static String normalizeLang(String lang) {
        if ("en".equals(lang) || "auto".equals(lang)) return lang;
        return "bn";
    }

    private final class NativeBridge {

        @JavascriptInterface
        public boolean isNative() {
            return true;
        }

        @JavascriptInterface
        public boolean isReduceMotion() {
            try {
                float scale = Settings.Global.getFloat(
                        getContentResolver(),
                        Settings.Global.ANIMATOR_DURATION_SCALE,
                        1f);
                return scale < 0.01f;
            } catch (Exception e) {
                return false;
            }
        }

        @JavascriptInterface
        public void vibrate(int ms) {
            try {
                Vibrator vibrator = (Vibrator) getSystemService(Context.VIBRATOR_SERVICE);
                if (vibrator == null || !vibrator.hasVibrator()) return;
                int duration = Math.max(1, Math.min(ms, 100));
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                    vibrator.vibrate(VibrationEffect.createOneShot(
                            duration, VibrationEffect.DEFAULT_AMPLITUDE));
                } else {
                    //noinspection deprecation
                    vibrator.vibrate(duration);
                }
            } catch (Exception ignored) {
            }
        }

        @JavascriptInterface
        public void copy(final String text) {
            if (text == null) return;
            runOnUiThread(() -> {
                ClipboardManager manager =
                        (ClipboardManager) getSystemService(Context.CLIPBOARD_SERVICE);
                if (manager != null) {
                    manager.setPrimaryClip(ClipData.newPlainText("KothaNote", text));
                }
            });
        }

        @JavascriptInterface
        public void share(final String text) {
            if (text == null) return;
            runOnUiThread(() -> {
                Intent send = new Intent(Intent.ACTION_SEND);
                send.setType("text/plain");
                send.putExtra(Intent.EXTRA_TEXT, text);
                startActivity(Intent.createChooser(send, "Share note"));
            });
        }

        @JavascriptInterface
        public boolean hasMicPermission() {
            if (Build.VERSION.SDK_INT < Build.VERSION_CODES.M) return true;
            return checkSelfPermission(Manifest.permission.RECORD_AUDIO)
                    == PackageManager.PERMISSION_GRANTED;
        }

        @JavascriptInterface
        public void requestMicPermission() {
            if (Build.VERSION.SDK_INT < Build.VERSION_CODES.M) return;
            runOnUiThread(() -> requestPermissions(
                    new String[]{Manifest.permission.RECORD_AUDIO}, REQ_MIC));
        }

        @JavascriptInterface
        public void prepareSpeech(String language) {
            speechEngine.prepare(normalizeLang(language));
        }

        @JavascriptInterface
        public String speechStatus() {
            return speechEngine.statusJson();
        }

        @JavascriptInterface
        public String startRecording(String language) {
            JSONObject out = new JSONObject();
            try {
                synchronized (recorderLock) {
                    if (recorder != null) {
                        out.put("ok", false);
                        out.put("error", "busy");
                        return out.toString();
                    }
                }
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M
                        && checkSelfPermission(Manifest.permission.RECORD_AUDIO)
                        != PackageManager.PERMISSION_GRANTED) {
                    out.put("ok", false);
                    out.put("error", "permission");
                    return out.toString();
                }
                if (!recordingsDir.exists() && !recordingsDir.mkdirs()) {
                    out.put("ok", false);
                    out.put("error", "storage");
                    return out.toString();
                }
                String name = "note_" + System.currentTimeMillis() + "_"
                        + UUID.randomUUID().toString().substring(0, 8) + ".wav";
                File file = new File(recordingsDir, name);
                Recorder next = new Recorder(file, normalizeLang(language));
                synchronized (recorderLock) {
                    recorder = next;
                }
                setKeepAwake(true);
                out.put("ok", true);
                out.put("file", name);
                return out.toString();
            } catch (Throwable t) {
                out = new JSONObject();
                try {
                    out.put("ok", false);
                    out.put("error", "microphone");
                    out.put("message", "Could not start the microphone.");
                } catch (Exception ignored) {
                }
                return out.toString();
            }
        }

        @JavascriptInterface
        public String recorderState() {
            Recorder current;
            synchronized (recorderLock) {
                current = recorder;
            }
            if (current == null) {
                return "{\"active\":false,\"paused\":false,\"ms\":0,\"level\":0}";
            }
            return current.stateJson();
        }

        @JavascriptInterface
        public boolean pauseRecording(boolean pause) {
            Recorder current;
            synchronized (recorderLock) {
                current = recorder;
            }
            if (current == null) return false;
            return current.pause(pause);
        }

        @JavascriptInterface
        public String stopRecording(String appendFile) {
            JSONObject out = new JSONObject();
            Recorder current;
            synchronized (recorderLock) {
                current = recorder;
                recorder = null;
            }
            setKeepAwake(false);
            if (current == null) {
                try {
                    out.put("ok", false);
                    out.put("error", "not_recording");
                } catch (Exception ignored) {
                }
                return out.toString();
            }

            long segmentMs = current.durationMs();
            if (segmentMs < 450) {
                current.cancel();
                try {
                    out.put("ok", false);
                    out.put("error", "too_short");
                } catch (Exception ignored) {
                }
                return out.toString();
            }

            File part;
            try {
                part = current.finish();
            } catch (Throwable t) {
                current.cancel();
                try {
                    out.put("ok", false);
                    out.put("error", "audio");
                } catch (Exception ignored) {
                }
                return out.toString();
            }

            String append = null;
            File existing = resolveAudio(appendFile);
            if (existing != null && existing.isFile()) {
                append = existing.getName();
            }
            speechEngine.transcribe(part, current.language, append, segmentMs);

            try {
                out.put("ok", true);
            } catch (Exception ignored) {
            }
            return out.toString();
        }

        @JavascriptInterface
        public void cancelRecording() {
            Recorder current;
            synchronized (recorderLock) {
                current = recorder;
                recorder = null;
            }
            if (current != null) current.cancel();
            setKeepAwake(false);
        }

        @JavascriptInterface
        public void playAudio(String file) {
            runOnUiThread(() -> startNativePlayback(file));
        }

        @JavascriptInterface
        public void pauseAudio() {
            runOnUiThread(() -> {
                try {
                    if (player != null && playerPrepared && player.isPlaying()) {
                        player.pause();
                    }
                    playerPlaying = false;
                } catch (Exception ignored) {
                }
            });
        }

        @JavascriptInterface
        public void stopAudio() {
            runOnUiThread(MainActivity.this::releasePlayer);
        }

        @JavascriptInterface
        public void seekAudio(int ms) {
            runOnUiThread(() -> {
                int target = Math.max(0, ms);
                pendingSeekMs = target;
                try {
                    if (player != null && playerPrepared) {
                        player.seekTo(target);
                        playerPositionMs = target;
                    }
                } catch (Exception ignored) {
                }
            });
        }

        @JavascriptInterface
        public void setSpeed(float speed) {
            float value = Math.max(0.5f, Math.min(2f, speed));
            playbackSpeed = value;
            runOnUiThread(() -> applyPlaybackSpeed());
        }

        @JavascriptInterface
        public String playerState() {
            MediaPlayer p = player;
            if (p != null && playerPrepared) {
                try {
                    playerPositionMs = Math.max(0, p.getCurrentPosition());
                    int d = p.getDuration();
                    if (d > 0) playerDurationMs = d;
                    playerPlaying = p.isPlaying();
                } catch (Exception ignored) {
                }
            }
            JSONObject out = new JSONObject();
            try {
                out.put("prepared", playerPrepared);
                out.put("playing", playerPlaying);
                out.put("positionMs", playerPositionMs);
                out.put("durationMs", playerDurationMs);
                out.put("hasAudio", playerFile != null);
            } catch (Exception ignored) {
            }
            return out.toString();
        }

        @JavascriptInterface
        public String audioInfo(String file) {
            JSONObject out = new JSONObject();
            try {
                File audio = resolveAudio(file);
                boolean exists = audio != null && audio.isFile();
                out.put("exists", exists);
                out.put("bytes", exists ? audio.length() : 0);
                out.put("durationMs", exists ? wavDurationMs(audio) : 0);
            } catch (Exception e) {
                try {
                    out.put("exists", false);
                    out.put("bytes", 0);
                    out.put("durationMs", 0);
                } catch (Exception ignored) {
                }
            }
            return out.toString();
        }

        @JavascriptInterface
        public long storageBytes() {
            long total = 0;
            File[] files = recordingsDir.listFiles();
            if (files != null) {
                for (File f : files) {
                    if (f.isFile() && f.getName().endsWith(".wav")) total += f.length();
                }
            }
            return total;
        }

        @JavascriptInterface
        public void deleteAudio(String file) {
            File audio = resolveAudio(file);
            if (audio == null) return;
            runOnUiThread(() -> {
                if (playerFile != null && playerFile.equals(audio.getName())) {
                    releasePlayer();
                }
            });
            ioExecutor.execute(() -> {
                //noinspection ResultOfMethodCallIgnored
                audio.delete();
            });
        }

        @JavascriptInterface
        public void pruneAudio(String activeNamesJson) {
            Set<String> keep = new HashSet<>();
            try {
                JSONArray array = new JSONArray(activeNamesJson == null ? "[]" : activeNamesJson);
                for (int i = 0; i < array.length(); i++) {
                    String name = array.optString(i, "");
                    File f = resolveAudio(name);
                    if (f != null) keep.add(f.getName());
                }
            } catch (Exception ignored) {
            }
            ioExecutor.execute(() -> {
                synchronized (recorderLock) {
                    if (recorder != null) return;
                }
                File[] files = recordingsDir.listFiles();
                if (files == null) return;
                long cutoff = System.currentTimeMillis() - 10 * 60 * 1000L;
                for (File f : files) {
                    if (f.isFile() && f.getName().endsWith(".wav")
                            && !keep.contains(f.getName())
                            && f.lastModified() < cutoff) {
                        //noinspection ResultOfMethodCallIgnored
                        f.delete();
                    }
                }
            });
        }

        @JavascriptInterface
        public boolean exportNotes(String content, String name) {
            if (content == null) return false;
            String filename = sanitizeExportName(name);
            if (Build.VERSION.SDK_INT <= Build.VERSION_CODES.P
                    && checkSelfPermission(Manifest.permission.WRITE_EXTERNAL_STORAGE)
                    != PackageManager.PERMISSION_GRANTED) {
                pendingExportContent = content;
                pendingExportName = filename;
                runOnUiThread(() -> requestPermissions(
                        new String[]{Manifest.permission.WRITE_EXTERNAL_STORAGE}, REQ_STORAGE));
                return true;
            }
            final String body = content;
            ioExecutor.execute(() -> writeExport(body, filename));
            return true;
        }
    }

    private static String sanitizeExportName(String name) {
        String base = (name == null || name.trim().isEmpty()) ? "KothaNote-notes.txt" : name.trim();
        base = base.replaceAll("[^A-Za-z0-9._-]", "-");
        if (!base.toLowerCase(Locale.US).endsWith(".txt")) base += ".txt";
        return base;
    }

    private void writeExport(String content, String filename) {
        String where = "";
        try {
            byte[] bytes = content.getBytes(StandardCharsets.UTF_8);
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
                ContentResolver resolver = getContentResolver();
                ContentValues values = new ContentValues();
                values.put(MediaStore.Downloads.DISPLAY_NAME, filename);
                values.put(MediaStore.Downloads.MIME_TYPE, "text/plain");
                values.put(MediaStore.Downloads.RELATIVE_PATH,
                        Environment.DIRECTORY_DOWNLOADS + "/KothaNote");
                values.put(MediaStore.Downloads.IS_PENDING, 1);
                Uri uri = resolver.insert(MediaStore.Downloads.EXTERNAL_CONTENT_URI, values);
                if (uri == null) throw new IOException("Could not create the download");
                try (OutputStream out = resolver.openOutputStream(uri)) {
                    if (out == null) throw new IOException("Could not open the download");
                    out.write(bytes);
                    out.flush();
                }
                ContentValues ready = new ContentValues();
                ready.put(MediaStore.Downloads.IS_PENDING, 0);
                resolver.update(uri, ready, null, null);
                where = "Downloads/KothaNote/" + filename;
            } else {
                File dir = new File(
                        Environment.getExternalStoragePublicDirectory(
                                Environment.DIRECTORY_DOWNLOADS),
                        "KothaNote");
                if (!dir.exists() && !dir.mkdirs()) {
                    throw new IOException("Could not create the Downloads folder");
                }
                File outFile = new File(dir, filename);
                try (FileOutputStream out = new FileOutputStream(outFile)) {
                    out.write(bytes);
                    out.flush();
                }
                MediaScannerConnection.scanFile(
                        this, new String[]{outFile.getAbsolutePath()}, new String[]{"text/plain"}, null);
                where = outFile.getAbsolutePath();
            }
            JSONObject result = new JSONObject();
            result.put("ok", true);
            result.put("path", where);
            emitCallback("onExportResult", result.toString());
        } catch (Throwable t) {
            try {
                JSONObject result = new JSONObject();
                result.put("ok", false);
                result.put("error", "Could not write the export file.");
                emitCallback("onExportResult", result.toString());
            } catch (Exception ignored) {
            }
        }
    }

    @Override
    public void onRequestPermissionsResult(int requestCode, String[] permissions, int[] grantResults) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults);
        boolean granted = grantResults.length > 0
                && grantResults[0] == PackageManager.PERMISSION_GRANTED;
        if (requestCode == REQ_MIC) {
            emit("window.onMicPermission && window.onMicPermission(" + granted + ");");
        } else if (requestCode == REQ_STORAGE) {
            if (granted && pendingExportContent != null) {
                final String body = pendingExportContent;
                final String name = pendingExportName;
                pendingExportContent = null;
                pendingExportName = null;
                ioExecutor.execute(() -> writeExport(body, name));
            } else {
                try {
                    JSONObject result = new JSONObject();
                    result.put("ok", false);
                    result.put("error", "Storage permission is needed to export.");
                    emitCallback("onExportResult", result.toString());
                } catch (Exception ignored) {
                }
            }
        }
    }

    /* ---------------------------------------------------------------------
       Native playback
       --------------------------------------------------------------------- */

    private void startNativePlayback(String file) {
        File audio = resolveAudio(file);
        if (audio == null || !audio.isFile()) {
            emit("window.onPlaybackError && window.onPlaybackError('This recording is missing.');");
            return;
        }
        try {
            if (player != null && audio.getName().equals(playerFile) && playerPrepared) {
                try {
                    int duration = player.getDuration();
                    if (duration > 0 && player.getCurrentPosition() >= duration - 80) {
                        player.seekTo(0);
                        playerPositionMs = 0;
                    }
                    pendingPlay = true;
                    player.start();
                    applyPlaybackSpeed();
                    playerPlaying = true;
                    return;
                } catch (Exception ignored) {
                    // Fall through and prepare the file again.
                }
            }
            releasePlayer();
            playerFile = audio.getName();
            playerPrepared = false;
            playerPlaying = false;
            playerPositionMs = 0;
            playerDurationMs = 0;
            pendingPlay = true;
            pendingSeekMs = -1;
            MediaPlayer next = new MediaPlayer();
            next.setDataSource(audio.getAbsolutePath());
            next.setOnPreparedListener(mp -> {
                playerPrepared = true;
                try {
                    playerDurationMs = Math.max(0, mp.getDuration());
                    applyPlaybackSpeed();
                    if (pendingSeekMs >= 0) {
                        mp.seekTo(pendingSeekMs);
                        playerPositionMs = pendingSeekMs;
                    }
                    if (pendingPlay) {
                        mp.start();
                        playerPlaying = true;
                    }
                } catch (Exception ignored) {
                }
            });
            next.setOnCompletionListener(mp -> {
                playerPlaying = false;
                playerPrepared = true;
                playerDurationMs = Math.max(playerDurationMs, mp.getDuration());
                playerPositionMs = playerDurationMs;
                emit("window.onPlaybackEnded && window.onPlaybackEnded();");
            });
            next.setOnErrorListener((mp, what, extra) -> {
                playerPrepared = false;
                playerPlaying = false;
                emit("window.onPlaybackError && window.onPlaybackError('This recording could not be played.');");
                return true;
            });
            player = next;
            next.prepareAsync();
        } catch (Exception e) {
            releasePlayer();
            emit("window.onPlaybackError && window.onPlaybackError('This recording could not be played.');");
        }
    }

    private void applyPlaybackSpeed() {
        if (player == null || !playerPrepared) return;
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
            try {
                PlaybackParams params = player.getPlaybackParams();
                params.setSpeed(playbackSpeed);
                params.setPitch(1f);
                player.setPlaybackParams(params);
            } catch (Exception ignored) {
            }
        }
    }

    private void releasePlayer() {
        try {
            if (player != null) {
                if (player.isPlaying()) player.stop();
                player.reset();
                player.release();
            }
        } catch (Exception ignored) {
        }
        player = null;
        playerFile = null;
        playerPrepared = false;
        playerPlaying = false;
        playerPositionMs = 0;
        playerDurationMs = 0;
        pendingPlay = false;
        pendingSeekMs = -1;
    }

    /* ---------------------------------------------------------------------
       Audio recorder
       --------------------------------------------------------------------- */

    private final class Recorder {
        final File file;
        final String language;
        final Object lock = new Object();

        private RandomAccessFile raf;
        private AudioRecord audioRecord;
        private Thread captureThread;
        private volatile boolean active = true;
        private volatile boolean paused;
        private volatile boolean capturing;
        private volatile long dataBytes;
        private volatile float level;
        private int sampleRate;
        private boolean finished;

        Recorder(File file, String language) throws Exception {
            this.file = file;
            this.language = language;
            this.raf = new RandomAccessFile(file, "rw");
            try {
                this.raf.setLength(0);
                this.raf.write(new byte[44]);
                this.raf.seek(44);
                startCapture();
            } catch (Exception e) {
                try {
                    this.raf.close();
                } catch (IOException ignored) {
                }
                this.raf = null;
                //noinspection ResultOfMethodCallIgnored
                file.delete();
                throw e;
            }
        }

        private void startCapture() throws Exception {
            synchronized (lock) {
                if (capturing || finished || !active) return;
            }
            int chosen = sampleRate;
            AudioRecord record = null;
            int[] rates = chosen > 0
                    ? new int[]{chosen, 16000, 44100, 48000}
                    : new int[]{16000, 44100, 48000};
            for (int rate : rates) {
                if (chosen > 0 && rate != chosen) continue;
                int min = AudioRecord.getMinBufferSize(
                        rate, AudioFormat.CHANNEL_IN_MONO, AudioFormat.ENCODING_PCM_16BIT);
                if (min <= 0) continue;
                try {
                    AudioRecord candidate = new AudioRecord(
                            MediaRecorder.AudioSource.MIC,
                            rate,
                            AudioFormat.CHANNEL_IN_MONO,
                            AudioFormat.ENCODING_PCM_16BIT,
                            Math.max(min * 2, rate / 5 * 2));
                    if (candidate.getState() == AudioRecord.STATE_INITIALIZED) {
                        record = candidate;
                        sampleRate = rate;
                        break;
                    }
                    candidate.release();
                } catch (Exception ignored) {
                }
            }
            if (record == null) {
                throw new IOException("No supported microphone sample rate");
            }
            try {
                record.startRecording();
            } catch (Exception e) {
                record.release();
                throw e;
            }
            if (record.getRecordingState() != AudioRecord.RECORDSTATE_RECORDING) {
                record.release();
                throw new IOException("Microphone did not start");
            }
            synchronized (lock) {
                if (finished || !active) {
                    try {
                        record.stop();
                    } catch (Exception ignored) {
                    }
                    record.release();
                    return;
                }
                audioRecord = record;
                capturing = true;
                paused = false;
                final AudioRecord activeRecord = record;
                captureThread = new Thread(() -> captureLoop(activeRecord), "kotha-recorder");
                captureThread.start();
            }
        }

        private void captureLoop(AudioRecord current) {
            short[] buffer = new short[2048];
            while (capturing && !paused) {
                int read;
                try {
                    read = current.read(buffer, 0, buffer.length);
                } catch (Exception e) {
                    break;
                }
                if (read <= 0) continue;
                byte[] bytes = new byte[read * 2];
                double sum = 0;
                for (int i = 0; i < read; i++) {
                    short sample = buffer[i];
                    bytes[i * 2] = (byte) (sample & 0xff);
                    bytes[i * 2 + 1] = (byte) ((sample >> 8) & 0xff);
                    sum += (double) sample * sample;
                }
                double rms = Math.sqrt(sum / Math.max(1, read));
                float nextLevel = (float) Math.min(1.0, rms / 7000.0);
                level = Math.max(nextLevel, level * 0.55f);
                synchronized (lock) {
                    if (!capturing || raf == null) break;
                    try {
                        raf.seek(44 + dataBytes);
                        raf.write(bytes);
                        dataBytes += bytes.length;
                    } catch (IOException e) {
                        break;
                    }
                }
            }
        }

        private void stopCapture() {
            capturing = false;
            AudioRecord record = audioRecord;
            audioRecord = null;
            if (record != null) {
                try {
                    record.stop();
                } catch (Exception ignored) {
                }
                try {
                    record.release();
                } catch (Exception ignored) {
                }
            }
            Thread thread = captureThread;
            captureThread = null;
            if (thread != null && thread != Thread.currentThread()) {
                try {
                    thread.join(1200);
                } catch (InterruptedException e) {
                    Thread.currentThread().interrupt();
                }
            }
            level = 0;
        }

        boolean pause(boolean pause) {
            synchronized (lock) {
                if (!active || finished) return false;
                if (paused == pause) return true;
                paused = pause;
            }
            if (pause) {
                stopCapture();
                return true;
            }
            try {
                startCapture();
                return true;
            } catch (Exception e) {
                synchronized (lock) {
                    paused = true;
                }
                return false;
            }
        }

        long durationMs() {
            if (sampleRate <= 0) return 0;
            return Math.round(dataBytes * 1000.0 / (sampleRate * 2.0));
        }

        String stateJson() {
            JSONObject out = new JSONObject();
            try {
                out.put("active", active && !finished);
                out.put("paused", paused);
                out.put("ms", durationMs());
                out.put("level", level);
            } catch (Exception ignored) {
            }
            return out.toString();
        }

        File finish() throws IOException {
            synchronized (lock) {
                if (finished) return file;
                finished = true;
                active = false;
                paused = false;
            }
            stopCapture();
            synchronized (lock) {
                long total = dataBytes;
                RandomAccessFile current = raf;
                raf = null;
                if (current == null) throw new IOException("Recorder file closed");
                try {
                    current.seek(0);
                    current.write(wavHeader(total, sampleRate, 1, 16));
                    current.setLength(44 + total);
                    current.getFD().sync();
                } finally {
                    try {
                        current.close();
                    } catch (IOException ignored) {
                    }
                }
            }
            return file;
        }

        void cancel() {
            synchronized (lock) {
                finished = true;
                active = false;
                paused = false;
            }
            stopCapture();
            RandomAccessFile current;
            synchronized (lock) {
                current = raf;
                raf = null;
            }
            if (current != null) {
                try {
                    current.close();
                } catch (IOException ignored) {
                }
            }
            //noinspection ResultOfMethodCallIgnored
            file.delete();
        }
    }

    /* ---------------------------------------------------------------------
       On-device speech recognition
       --------------------------------------------------------------------- */

    private final class SpeechEngine {
        private final Object lock = new Object();
        private OfflineRecognizer recognizer;
        private volatile String state = "idle";
        private volatile int progress = 0;
        private volatile String message = "Whisper Tiny · on-device";
        private volatile String lastError = "";

        void prepare(String language) {
            speechExecutor.execute(() -> {
                try {
                    synchronized (lock) {
                        if ("ready".equals(state) && recognizer != null) return;
                    }
                    setState("preparing", 5, "Preparing on-device speech…");
                    ensureRecognizer();
                    setState("ready", 100, "Whisper Tiny · on-device");
                } catch (Throwable t) {
                    setError(friendlySpeechError(t));
                }
            });
        }

        private void ensureRecognizer() {
            synchronized (lock) {
                if (recognizer != null) return;
            }
            OfflineRecognizerConfig config = new OfflineRecognizerConfig();
            OfflineModelConfig model = config.getModelConfig();
            OfflineWhisperModelConfig whisper = model.getWhisper();
            whisper.setEncoder("asr/tiny-encoder.int8.onnx");
            whisper.setDecoder("asr/tiny-decoder.int8.onnx");
            // Load one multilingual recognizer. The language for each note is
            // selected on its own stream, so switching languages never needs a
            // costly model reload.
            whisper.setLanguage("");
            whisper.setTask("transcribe");
            whisper.setTailPaddings(300);
            model.setTokens("asr/tiny-tokens.txt");
            model.setNumThreads(Math.min(4, Math.max(2,
                    Runtime.getRuntime().availableProcessors() - 1)));
            model.setProvider("cpu");
            model.setDebug(false);
            config.setModelConfig(model);
            config.setDecodingMethod("greedy_search");

            OfflineRecognizer next = new OfflineRecognizer(getAssets(), config);
            OfflineRecognizer old;
            synchronized (lock) {
                old = recognizer;
                recognizer = next;
            }
            if (old != null) {
                try {
                    old.release();
                } catch (Exception ignored) {
                }
            }
        }

        void transcribe(final File part, final String language,
                        final String appendFile, final long segmentMs) {
            speechExecutor.execute(() -> {
                File finalFile = part;
                try {
                    setState("transcribing", 0, "Transcribing on this device…");
                    ensureRecognizer();
                    WavData wav = readWav(part);
                    if (wav.samples.length < 1600) {
                        throw new NoSpeechException();
                    }
                    DecodeResult decoded = decode(wav, language);
                    String text = cleanText(decoded.text);
                    if (text.isEmpty()) throw new NoSpeechException();

                    boolean appended = false;
                    int totalMs;
                    if (appendFile != null) {
                        File existing = resolveAudio(appendFile);
                        if (existing != null && existing.isFile()) {
                            concatenateWav(existing, part);
                            //noinspection ResultOfMethodCallIgnored
                            part.delete();
                            finalFile = existing;
                            appended = true;
                            totalMs = wavDurationMs(existing);
                        } else {
                            totalMs = wavDurationMs(part);
                        }
                    } else {
                        totalMs = wavDurationMs(part);
                    }

                    JSONObject result = new JSONObject();
                    result.put("ok", true);
                    result.put("text", text);
                    result.put("lang", decoded.lang);
                    result.put("file", finalFile.getName());
                    result.put("durationMs", totalMs);
                    result.put("segmentMs", segmentMs);
                    result.put("appended", appended);
                    setState("ready", 100, "Whisper Tiny · on-device");
                    emitCallback("onTranscriptionResult", result.toString());
                } catch (NoSpeechException e) {
                    int remainingMs = wavDurationMs(part);
                    // Keep a real attempt that produced no words instead of
                    // throwing the recording away. Short blips are discarded.
                    boolean keepAudio = appendFile == null && remainingMs >= 1500;
                    if (!keepAudio) {
                        //noinspection ResultOfMethodCallIgnored
                        part.delete();
                    }
                    JSONObject result = new JSONObject();
                    try {
                        result.put("ok", false);
                        result.put("error", "no_speech");
                        result.put("message", "No speech was recognised. Try again.");
                        if (keepAudio) {
                            result.put("file", part.getName());
                            result.put("durationMs", remainingMs);
                        }
                    } catch (Exception ignored) {
                    }
                    setState("ready", 100, "Whisper Tiny · on-device");
                    emitCallback("onTranscriptionResult", result.toString());
                } catch (Throwable t) {
                    int remainingMs = wavDurationMs(part);
                    boolean keepAudio = appendFile == null && remainingMs >= 450;
                    if (!keepAudio) {
                        //noinspection ResultOfMethodCallIgnored
                        part.delete();
                    }
                    JSONObject result = new JSONObject();
                    try {
                        result.put("ok", false);
                        result.put("error", "transcription");
                        result.put("message", friendlySpeechError(t));
                        result.put("durationMs", remainingMs);
                        if (keepAudio) result.put("file", part.getName());
                    } catch (Exception ignored) {
                    }
                    setError(friendlySpeechError(t));
                    emitCallback("onTranscriptionResult", result.toString());
                }
            });
        }

        private DecodeResult decode(WavData wav, String language) throws IOException {
            short[] all = wav.sampleRate == 16000
                    ? wav.samples
                    : resample(wav.samples, wav.sampleRate, 16000);
            String lang = normalizeLang(language);
            if ("auto".equals(lang)) lang = "";

            OfflineRecognizer current;
            synchronized (lock) {
                current = recognizer;
            }
            if (current == null) throw new IOException("Speech model is not ready");

            // The native Whisper decoder handles at most 30 seconds at a time.
            // Split longer notes into 28-second pieces so nothing is dropped.
            final int chunkSamples = 16000 * 28;
            StringBuilder text = new StringBuilder();
            String detected = "";

            if (all.length <= chunkSamples) {
                DecodeResult one = decodeChunk(current, all, 0, all.length, lang);
                text.append(one.text);
                detected = one.lang;
            } else {
                for (int start = 0; start < all.length; start += chunkSamples) {
                    int end = Math.min(all.length, start + chunkSamples);
                    if (end - start < 1600) break;
                    int pct = Math.min(95, Math.round(start * 100f / all.length));
                    setState("transcribing", pct, "Transcribing on this device…");
                    DecodeResult part = decodeChunk(current, all, start, end, lang);
                    String cleaned = cleanText(part.text);
                    if (!cleaned.isEmpty()) {
                        if (text.length() > 0) text.append(' ');
                        text.append(cleaned);
                    }
                    if (detected.isEmpty()) detected = part.lang;
                }
            }

            DecodeResult out = new DecodeResult();
            out.text = text.toString();
            out.lang = detected;
            return out;
        }

        private DecodeResult decodeChunk(OfflineRecognizer recognizer, short[] samples,
                                         int start, int end, String lang) {
            int count = end - start;
            float[] floats = new float[count];
            for (int i = 0; i < count; i++) {
                floats[i] = samples[start + i] / 32768.0f;
            }
            OfflineStream stream = null;
            try {
                stream = recognizer.createStream();
                stream.setOption("language", lang);
                stream.acceptWaveform(floats, 16000);
                recognizer.decode(stream);
                OfflineRecognizerResult result = recognizer.getResult(stream);
                DecodeResult out = new DecodeResult();
                out.text = result.getText();
                out.lang = result.getLang() == null ? "" : result.getLang();
                return out;
            } finally {
                if (stream != null) {
                    try {
                        stream.release();
                    } catch (Exception ignored) {
                    }
                }
            }
        }

        private void setState(String next, int pct, String text) {
            state = next;
            progress = pct;
            message = text;
            if (!"error".equals(next)) lastError = "";
            emitCallback("onSpeechStatus", statusJson());
        }

        private void setError(String error) {
            state = "error";
            progress = 0;
            message = "On-device speech is unavailable";
            lastError = error;
            emitCallback("onSpeechStatus", statusJson());
        }

        String statusJson() {
            JSONObject out = new JSONObject();
            try {
                out.put("state", state);
                out.put("ready", "ready".equals(state));
                out.put("progress", progress);
                out.put("message", message);
                out.put("error", lastError);
                out.put("language", "multi");
                out.put("model", "Whisper Tiny");
            } catch (Exception ignored) {
            }
            return out.toString();
        }

        void releaseAsync() {
            speechExecutor.execute(() -> {
                OfflineRecognizer old;
                synchronized (lock) {
                    old = recognizer;
                    recognizer = null;
                    state = "idle";
                }
                if (old != null) {
                    try {
                        old.release();
                    } catch (Exception ignored) {
                    }
                }
            });
        }
    }

    private static final class DecodeResult {
        String text;
        String lang;
    }

    private static final class NoSpeechException extends Exception {
    }

    private static String cleanText(String text) {
        if (text == null) return "";
        String value = text.replace('\n', ' ').replace('\r', ' ').trim();
        value = value.replaceAll("\\s+", " ");
        if (value.length() < 2) return "";
        if (value.matches("^[\\[\\](){}<>.,!?…\\-–—:;'\"\\s]+$")) return "";
        return value;
    }

    private static String friendlySpeechError(Throwable t) {
        String value = t == null || t.getMessage() == null ? "" : t.getMessage();
        if (value.length() > 180) value = value.substring(0, 180);
        return "The on-device speech model could not finish." +
                (value.isEmpty() ? "" : " (" + value + ")");
    }

    /* ---------------------------------------------------------------------
       WAV helpers
       --------------------------------------------------------------------- */

    private static final class WavData {
        short[] samples;
        int sampleRate;
    }

    private static byte[] wavHeader(long dataBytes, int sampleRate, int channels, int bits) {
        int byteRate = sampleRate * channels * bits / 8;
        int blockAlign = channels * bits / 8;
        ByteBuffer buffer = ByteBuffer.allocate(44).order(ByteOrder.LITTLE_ENDIAN);
        buffer.put("RIFF".getBytes(StandardCharsets.US_ASCII));
        buffer.putInt((int) Math.min(0xFFFFFFFFL, 36 + dataBytes));
        buffer.put("WAVE".getBytes(StandardCharsets.US_ASCII));
        buffer.put("fmt ".getBytes(StandardCharsets.US_ASCII));
        buffer.putInt(16);
        buffer.putShort((short) 1);
        buffer.putShort((short) channels);
        buffer.putInt(sampleRate);
        buffer.putInt(byteRate);
        buffer.putShort((short) blockAlign);
        buffer.putShort((short) bits);
        buffer.put("data".getBytes(StandardCharsets.US_ASCII));
        buffer.putInt((int) Math.min(0xFFFFFFFFL, dataBytes));
        return buffer.array();
    }

    private static WavData readWav(File file) throws IOException {
        try (DataInputStream in = new DataInputStream(
                new BufferedInputStream(new FileInputStream(file)))) {
            byte[] riff = new byte[12];
            in.readFully(riff);
            if (!"RIFF".equals(new String(riff, 0, 4, StandardCharsets.US_ASCII))
                    || !"WAVE".equals(new String(riff, 8, 4, StandardCharsets.US_ASCII))) {
                throw new IOException("Not a WAV file");
            }
            int sampleRate = 0;
            int channels = 1;
            int bits = 16;
            int format = 1;
            byte[] data = null;
            long remaining = file.length() - 12;
            while (remaining >= 8) {
                byte[] idBytes = new byte[4];
                in.readFully(idBytes);
                remaining -= 4;
                long size = readLittleInt(in);
                remaining -= 4;
                String id = new String(idBytes, StandardCharsets.US_ASCII);
                if (size < 0 || size > remaining) {
                    if ("data".equals(id)) size = Math.max(0, remaining);
                    else break;
                }
                if ("fmt ".equals(id)) {
                    if (size < 16) throw new IOException("Bad WAV format");
                    format = readLittleShort(in);
                    channels = readLittleShort(in);
                    long rate = readLittleInt(in);
                    sampleRate = (int) rate;
                    //noinspection ResultOfMethodCallIgnored
                    readLittleInt(in); // byte rate
                    //noinspection ResultOfMethodCallIgnored
                    readLittleShort(in); // block align
                    bits = readLittleShort(in);
                    long skip = size - 16;
                    if (skip > 0) skipFully(in, skip);
                } else if ("data".equals(id)) {
                    if (data != null) {
                        //noinspection ResultOfMethodCallIgnored
                        skipFully(in, size);
                    } else {
                        if (size > 300_000_000L) throw new IOException("Audio is too large");
                        data = new byte[(int) size];
                        in.readFully(data);
                    }
                } else {
                    skipFully(in, size);
                }
                remaining -= size;
                if ((size & 1) == 1) {
                    if (in.read() >= 0) remaining--;
                }
                if (data != null && sampleRate > 0) break;
            }
            if (data == null || sampleRate <= 0) throw new IOException("WAV has no audio");
            if (format != 1 || bits != 16) throw new IOException("Only 16-bit PCM is supported");
            short[] samples;
            if (channels == 2) {
                samples = new short[data.length / 4];
                for (int i = 0, p = 0; i < samples.length; i++, p += 4) {
                    int left = (short) ((data[p] & 0xff) | (data[p + 1] << 8));
                    int right = (short) ((data[p + 2] & 0xff) | (data[p + 3] << 8));
                    samples[i] = (short) ((left + right) / 2);
                }
            } else {
                samples = new short[data.length / 2];
                for (int i = 0, p = 0; i < samples.length; i++, p += 2) {
                    samples[i] = (short) ((data[p] & 0xff) | (data[p + 1] << 8));
                }
            }
            WavData wav = new WavData();
            wav.samples = samples;
            wav.sampleRate = sampleRate;
            return wav;
        }
    }

    private static int wavDurationMs(File file) {
        if (file == null || !file.isFile()) return 0;
        try (RandomAccessFile raf = new RandomAccessFile(file, "r")) {
            byte[] header = new byte[12];
            raf.readFully(header);
            if (!"RIFF".equals(new String(header, 0, 4, StandardCharsets.US_ASCII))
                    || !"WAVE".equals(new String(header, 8, 4, StandardCharsets.US_ASCII))) {
                return 0;
            }
            int channels = 1;
            int bits = 16;
            int rate = 0;
            long dataBytes = 0;
            long position = 12;
            long length = raf.length();
            while (position + 8 <= length) {
                raf.seek(position);
                byte[] idBytes = new byte[4];
                raf.readFully(idBytes);
                long size = readLittleInt(raf);
                position += 8;
                String id = new String(idBytes, StandardCharsets.US_ASCII);
                if ("fmt ".equals(id) && size >= 16 && position + 16 <= length) {
                    raf.seek(position + 2);
                    channels = readLittleShort(raf);
                    rate = readLittleInt(raf);
                    raf.seek(position + 14);
                    bits = readLittleShort(raf);
                } else if ("data".equals(id)) {
                    dataBytes = Math.min(size, length - position);
                    break;
                }
                position += size + (size & 1);
            }
            if (rate <= 0) return 0;
            return (int) Math.min(Integer.MAX_VALUE,
                    dataBytes * 1000L / Math.max(1, rate * channels * bits / 8));
        } catch (Exception e) {
            return 0;
        }
    }

    private static short[] resample(short[] input, int from, int to) {
        if (from == to || input.length == 0) return input;
        int outputLength = Math.max(1,
                (int) Math.round(input.length * (double) to / (double) from));
        short[] output = new short[outputLength];
        double step = from / (double) to;
        for (int i = 0; i < outputLength; i++) {
            double source = i * step;
            int index = (int) source;
            double fraction = source - index;
            int a = input[Math.min(input.length - 1, index)];
            int b = input[Math.min(input.length - 1, index + 1)];
            output[i] = (short) Math.max(Short.MIN_VALUE, Math.min(Short.MAX_VALUE,
                    Math.round(a + (b - a) * fraction)));
        }
        return output;
    }

    private static void concatenateWav(File existing, File part) throws IOException {
        WavData first = readWav(existing);
        WavData second = readWav(part);
        short[] a = first.sampleRate == 16000
                ? first.samples : resample(first.samples, first.sampleRate, 16000);
        short[] b = second.sampleRate == 16000
                ? second.samples : resample(second.samples, second.sampleRate, 16000);
        short[] merged = new short[a.length + b.length];
        System.arraycopy(a, 0, merged, 0, a.length);
        System.arraycopy(b, 0, merged, a.length, b.length);
        File temp = new File(existing.getParentFile(),
                existing.getName() + ".tmp");
        writeWav(temp, merged, 16000);
        if (!temp.renameTo(existing)) {
            // On some file systems rename over an existing file fails.
            //noinspection ResultOfMethodCallIgnored
            existing.delete();
            if (!temp.renameTo(existing)) {
                //noinspection ResultOfMethodCallIgnored
                temp.delete();
                throw new IOException("Could not update the recording");
            }
        }
    }

    private static void writeWav(File file, short[] samples, int sampleRate) throws IOException {
        try (BufferedOutputStream out = new BufferedOutputStream(
                new FileOutputStream(file))) {
            out.write(wavHeader(samples.length * 2L, sampleRate, 1, 16));
            byte[] buffer = new byte[8192];
            int offset = 0;
            for (short sample : samples) {
                buffer[offset++] = (byte) (sample & 0xff);
                buffer[offset++] = (byte) ((sample >> 8) & 0xff);
                if (offset >= buffer.length) {
                    out.write(buffer, 0, offset);
                    offset = 0;
                }
            }
            if (offset > 0) out.write(buffer, 0, offset);
            out.flush();
        }
    }

    private static long readLittleInt(DataInputStream in) throws IOException {
        return (in.readUnsignedByte())
                | ((long) in.readUnsignedByte() << 8)
                | ((long) in.readUnsignedByte() << 16)
                | ((long) in.readUnsignedByte() << 24);
    }

    private static int readLittleInt(RandomAccessFile in) throws IOException {
        return (in.readUnsignedByte())
                | (in.readUnsignedByte() << 8)
                | (in.readUnsignedByte() << 16)
                | (in.readUnsignedByte() << 24);
    }

    private static int readLittleShort(DataInputStream in) throws IOException {
        return in.readUnsignedByte() | (in.readUnsignedByte() << 8);
    }

    private static int readLittleShort(RandomAccessFile in) throws IOException {
        return in.readUnsignedByte() | (in.readUnsignedByte() << 8);
    }

    private static void skipFully(InputStream in, long count) throws IOException {
        long left = count;
        while (left > 0) {
            long skipped = in.skip(left);
            if (skipped <= 0) {
                if (in.read() < 0) break;
                skipped = 1;
            }
            left -= skipped;
        }
    }

    /* ---------------------------------------------------------------------
       Lifecycle
       --------------------------------------------------------------------- */

    @Override
    @SuppressWarnings("deprecation")
    public void onBackPressed() {
        if (webView == null) {
            super.onBackPressed();
            return;
        }
        webView.evaluateJavascript(
                "(typeof window.appBack === 'function') && window.appBack() === true",
                value -> {
                    if (!"true".equals(value)) finish();
                });
    }

    @Override
    protected void onPause() {
        if (webView != null) webView.onPause();
        super.onPause();
    }

    @Override
    protected void onResume() {
        super.onResume();
        if (webView != null) webView.onResume();
    }

    @Override
    protected void onStop() {
        if (!isChangingConfigurations()) {
            Recorder current;
            synchronized (recorderLock) {
                current = recorder;
                recorder = null;
            }
            if (current != null) {
                current.cancel();
                setKeepAwake(false);
                emit("window.onRecordingInterrupted && window.onRecordingInterrupted();");
            }
        }
        super.onStop();
    }

    @Override
    protected void onDestroy() {
        releasePlayer();
        Recorder current;
        synchronized (recorderLock) {
            current = recorder;
            recorder = null;
        }
        if (current != null) current.cancel();
        setKeepAwake(false);
        if (speechEngine != null) speechEngine.releaseAsync();
        if (speechExecutor != null) speechExecutor.shutdown();
        if (ioExecutor != null) ioExecutor.shutdownNow();
        if (webView != null) {
            webView.removeJavascriptInterface("Android");
            webView.destroy();
            webView = null;
        }
        super.onDestroy();
    }
}

# KothaNote has no native dependencies. Keep the JavaScript bridge if a
# release build ever enables shrinking.
-keepclassmembers class com.kothanote.app.MainActivity$NativeBridge {
    @android.webkit.JavascriptInterface <methods>;
}

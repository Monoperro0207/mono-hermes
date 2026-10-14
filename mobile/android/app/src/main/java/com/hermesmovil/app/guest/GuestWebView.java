package com.hermesmovil.app.guest;

import android.content.Context;
import android.graphics.Bitmap;
import android.graphics.Color;
import android.net.http.SslError;
import android.os.Build;
import android.os.Message;
import android.view.View;
import android.view.ViewGroup;
import android.webkit.ConsoleMessage;
import android.webkit.CookieManager;
import android.webkit.GeolocationPermissions;
import android.webkit.JsPromptResult;
import android.webkit.JsResult;
import android.webkit.PermissionRequest;
import android.webkit.RenderProcessGoneDetail;
import android.webkit.SslErrorHandler;
import android.webkit.ValueCallback;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceError;
import android.webkit.WebResourceRequest;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import com.getcapacitor.JSObject;
import java.security.SecureRandom;
import java.util.ArrayList;
import java.util.List;
import org.json.JSONObject;
import org.json.JSONTokener;

/**
 * One guest browser: a hardened Android WebView plus the glue that reports its life to JavaScript.
 *
 * Hardening, in one place: no JavaScript interface of any kind (so a page can never reach app code),
 * no file/content access, mixed content refused, Safe Browsing on, no form saving or geolocation,
 * every permission request denied, TLS errors cancelled (never proceed), downloads and file choosers
 * refused, JS dialogs suppressed, third-party cookies off, and every navigation (redirects included)
 * and popup target checked by {@link GuestUrlPolicy}. UI thread only.
 */
final class GuestWebView {
    interface Listener {
        void onEvent(GuestWebView guest, String type, JSObject extra);

        void onRenderProcessGone(GuestWebView guest);
    }

    interface EvalCallback {
        void done(boolean ok, String json, String message);
    }

    private static final SecureRandom RANDOM = new SecureRandom();

    final int id;
    final WebView view;
    final GuestInput input;
    long lastVisibleAt = android.os.SystemClock.uptimeMillis();
    boolean visible;

    private final Listener listener;
    private final List<Pending> pending = new ArrayList<>();
    private String lastUrl = "";
    private String lastTitle = "";
    private boolean lastCanGoBack;
    private boolean lastCanGoForward;
    private boolean pendingNav;
    private boolean noCacheOnce;
    private boolean muted;
    private boolean destroyed;

    GuestWebView(Context context, int id, Listener listener) {
        this.id = id;
        this.listener = listener;
        this.view = new WebView(context);
        this.input = new GuestInput(view);
        view.setBackgroundColor(Color.WHITE);
        view.setVisibility(View.INVISIBLE);
        view.setFocusable(true);
        view.setFocusableInTouchMode(true);
        harden(view.getSettings());
        view.getSettings().setJavaScriptEnabled(true);
        view.getSettings().setDomStorageEnabled(true);
        CookieManager.getInstance().setAcceptThirdPartyCookies(view, false);
        view.setDownloadListener((url, userAgent, contentDisposition, mimeType, contentLength) -> { });
        view.setWebViewClient(new Client());
        view.setWebChromeClient(new Chrome());
    }

    /** Settings shared by the guest and by the throwaway popup view. No JS interface is ever added. */
    @SuppressWarnings("deprecation")
    private static void harden(WebSettings s) {
        s.setAllowFileAccess(false);
        s.setAllowContentAccess(false);
        s.setAllowFileAccessFromFileURLs(false);
        s.setAllowUniversalAccessFromFileURLs(false);
        s.setMixedContentMode(WebSettings.MIXED_CONTENT_NEVER_ALLOW);
        s.setSaveFormData(false);
        s.setGeolocationEnabled(false);
        s.setJavaScriptCanOpenWindowsAutomatically(false);
        if (Build.VERSION.SDK_INT >= 26) s.setSafeBrowsingEnabled(true);
    }

    // --- navigation ------------------------------------------------------------------------------

    /** Starts loading {@code url}; returns the refusal reason, or null when the load began. */
    String load(String url) {
        GuestUrlPolicy.Verdict verdict = GuestUrlPolicy.check(url);
        if (!verdict.allowed) return verdict.reason;
        view.loadUrl(url.trim());
        return null;
    }

    void reportBlocked(String url, String reason) {
        JSObject extra = new JSObject();
        extra.put("reason", "blocked");
        extra.put("androidCode", 0);
        extra.put("description", reason);
        extra.put("url", url);
        emit("fail", extra);
    }

    void navigate(String action) {
        switch (action) {
            case "back":
                if (view.canGoBack()) view.goBack();
                break;
            case "forward":
                if (view.canGoForward()) view.goForward();
                break;
            case "reloadIgnoringCache":
                noCacheOnce = true;
                view.getSettings().setCacheMode(WebSettings.LOAD_NO_CACHE);
                view.reload();
                break;
            default:
                view.reload();
                break;
        }
    }

    void place(boolean show, int left, int top, int width, int height) {
        if (destroyed) return;
        if (show) {
            ViewGroup.LayoutParams lp = view.getLayoutParams();
            if (lp.width != width || lp.height != height) {
                lp.width = width;
                lp.height = height;
                view.setLayoutParams(lp);
            }
            view.setTranslationX(left);
            view.setTranslationY(top);
            if (view.getVisibility() != View.VISIBLE) {
                view.setVisibility(View.VISIBLE);
                view.invalidate();
            }
            lastVisibleAt = android.os.SystemClock.uptimeMillis();
        } else {
            view.clearFocus();
            view.setVisibility(View.INVISIBLE);
        }
        visible = show;
    }

    void setMuted(boolean mute) {
        muted = mute;
        applyMute();
    }

    private void applyMute() {
        // WebView has no audio switch: mute every media element now and any that starts playing later.
        view.evaluateJavascript("(function(m){window.__hmMute=m;"
            + "document.querySelectorAll('audio,video').forEach(function(e){e.muted=m});"
            + "if(!window.__hmMuteHook){window.__hmMuteHook=1;document.addEventListener('play',function(e){"
            + "if(window.__hmMute&&e.target&&e.target.muted===false)e.target.muted=true},true)}})(" + muted + ")", null);
    }

    void onPause() {
        if (!destroyed) view.onPause();
    }

    void onResume() {
        if (!destroyed) view.onResume();
    }

    void destroy() {
        if (destroyed) return;
        snapshot();
        destroyed = true;
        for (Pending p : new ArrayList<>(pending)) p.finish(false, null, "The page was closed.");
        ViewGroup parent = (ViewGroup) view.getParent();
        if (parent != null) parent.removeView(view);
        view.stopLoading();
        view.setWebViewClient(new WebViewClient());
        view.setWebChromeClient(null);
        view.destroy();
    }

    // --- events ----------------------------------------------------------------------------------

    /** Caches what the renderer asks for synchronously (URL, title, history flags). */
    private void snapshot() {
        if (destroyed) return;
        String url = view.getUrl();
        if (url != null && GuestUrlPolicy.check(url).allowed) lastUrl = url;
        String title = view.getTitle();
        if (title != null) lastTitle = title;
        lastCanGoBack = view.canGoBack();
        lastCanGoForward = view.canGoForward();
    }

    /** An event carrying the cached page state; the renderer answers getURL() / canGoBack() from it. */
    JSObject stateEvent(String type, JSObject extra) {
        snapshot();
        JSObject event = extra == null ? new JSObject() : extra;
        event.put("id", id);
        event.put("type", type);
        event.put("title", lastTitle);
        event.put("canGoBack", lastCanGoBack);
        event.put("canGoForward", lastCanGoForward);
        if (!event.has("url") || !"fail".equals(type)) event.put("url", lastUrl);
        return event;
    }

    void emit(String type, JSObject extra) {
        listener.onEvent(this, type, stateEvent(type, extra));
    }

    private final class Client extends WebViewClient {
        @Override
        public boolean shouldOverrideUrlLoading(WebView v, WebResourceRequest request) {
            String url = request.getUrl().toString();
            GuestUrlPolicy.Verdict verdict = GuestUrlPolicy.check(url);
            if (verdict.allowed) return false;
            if (request.isForMainFrame()) reportBlocked(url, verdict.reason);
            return true;
        }

        @Override
        public void onPageStarted(WebView v, String url, Bitmap favicon) {
            pendingNav = true;
            emit("start", null);
        }

        @Override
        public void onPageFinished(WebView v, String url) {
            pendingNav = false;
            if (noCacheOnce) {
                noCacheOnce = false;
                v.getSettings().setCacheMode(WebSettings.LOAD_DEFAULT);
            }
            if (muted) applyMute();
            emit("domReady", null);
            emit("stop", null);
        }

        @Override
        public void doUpdateVisitedHistory(WebView v, String url, boolean isReload) {
            if (!GuestUrlPolicy.check(url).allowed) return;
            lastUrl = url;
            JSObject extra = new JSObject();
            extra.put("inPage", !pendingNav);
            emit("navigate", extra);
        }

        @Override
        public void onReceivedError(WebView v, WebResourceRequest request, WebResourceError error) {
            if (!request.isForMainFrame()) return;
            JSObject extra = new JSObject();
            extra.put("reason", "load");
            extra.put("androidCode", error.getErrorCode());
            extra.put("description", String.valueOf(error.getDescription()));
            extra.put("url", request.getUrl().toString());
            emit("fail", extra);
        }

        @Override
        public void onReceivedSslError(WebView v, SslErrorHandler handler, SslError error) {
            handler.cancel(); // never proceed
            JSObject extra = new JSObject();
            extra.put("reason", "ssl");
            extra.put("androidCode", error.getPrimaryError());
            extra.put("description", "TLS certificate error");
            extra.put("url", error.getUrl());
            emit("fail", extra);
        }

        @Override
        public boolean onRenderProcessGone(WebView v, RenderProcessGoneDetail detail) {
            listener.onRenderProcessGone(GuestWebView.this);
            return true;
        }
    }

    private final class Chrome extends WebChromeClient {
        @Override
        public void onReceivedTitle(WebView v, String title) {
            emit("title", null);
        }

        @Override
        public boolean onConsoleMessage(ConsoleMessage m) {
            JSObject extra = new JSObject();
            extra.put("level", m.messageLevel().name());
            extra.put("message", m.message());
            extra.put("line", m.lineNumber());
            extra.put("sourceId", m.sourceId());
            emit("console", extra);
            return true;
        }

        @Override
        public void onPermissionRequest(PermissionRequest request) {
            request.deny();
        }

        @Override
        public void onGeolocationPermissionsShowPrompt(String origin, GeolocationPermissions.Callback callback) {
            callback.invoke(origin, false, false);
        }

        @Override
        public boolean onShowFileChooser(WebView v, ValueCallback<android.net.Uri[]> callback, FileChooserParams params) {
            callback.onReceiveValue(null);
            return true;
        }

        @Override
        public boolean onJsAlert(WebView v, String url, String message, JsResult result) {
            result.cancel();
            return true;
        }

        @Override
        public boolean onJsConfirm(WebView v, String url, String message, JsResult result) {
            result.cancel();
            return true;
        }

        @Override
        public boolean onJsPrompt(WebView v, String url, String message, String defaultValue, JsPromptResult result) {
            result.cancel();
            return true;
        }

        /**
         * A user-initiated `_blank` link or window.open never opens a window. A throwaway view (JS off,
         * never attached) receives the navigation only so its target URL can be read; the renderer is
         * told to hand that URL to the system browser, and the view is destroyed.
         */
        @Override
        public boolean onCreateWindow(WebView v, boolean isDialog, boolean isUserGesture, Message resultMsg) {
            if (!isUserGesture || !(resultMsg.obj instanceof WebView.WebViewTransport)) return false;
            final WebView popup = new WebView(v.getContext());
            harden(popup.getSettings());
            popup.getSettings().setJavaScriptEnabled(false);
            final boolean[] done = {false};
            final Runnable discard = () -> {
                popup.stopLoading();
                popup.destroy();
            };
            popup.setWebViewClient(new WebViewClient() {
                private void capture(String url) {
                    if (done[0]) return;
                    done[0] = true;
                    if (GuestUrlPolicy.check(url).allowed && !GuestUrlPolicy.ABOUT_BLANK.equals(url)) {
                        JSObject extra = new JSObject();
                        extra.put("target", url);
                        emit("external", extra);
                    }
                    v.post(discard);
                }

                @Override
                public boolean shouldOverrideUrlLoading(WebView p, WebResourceRequest request) {
                    capture(request.getUrl().toString());
                    return true;
                }

                @Override
                public void onPageStarted(WebView p, String url, Bitmap favicon) {
                    capture(url);
                }
            });
            // A popup that never navigates must not leak its view.
            v.postDelayed(() -> {
                if (!done[0]) {
                    done[0] = true;
                    discard.run();
                }
            }, 10_000);
            WebView.WebViewTransport transport = (WebView.WebViewTransport) resultMsg.obj;
            transport.setWebView(popup);
            resultMsg.sendToTarget();
            return true;
        }
    }

    // --- scripts ---------------------------------------------------------------------------------

    private final class Pending {
        final EvalCallback callback;
        boolean finished;

        Pending(EvalCallback callback) {
            this.callback = callback;
        }

        void finish(boolean ok, String json, String message) {
            if (finished) return;
            finished = true;
            pending.remove(this);
            callback.done(ok, json, message);
        }
    }

    /**
     * Runs {@code code} in the page and reports its settled value as JSON text, awaiting a returned
     * promise. No JavaScript interface is involved: the script parks its outcome on a non-enumerable
     * window property under a random per-call key, and this side polls that key with evaluateJavascript.
     * If the page's CSP forbids eval, the code runs directly instead (synchronous results only).
     */
    void evaluate(String code, long timeoutMs, EvalCallback callback) {
        if (destroyed) {
            callback.done(false, null, "The page was closed.");
            return;
        }
        final Pending p = new Pending(callback);
        pending.add(p);
        view.postDelayed(() -> p.finish(false, null, "Script timed out."), timeoutMs);

        byte[] bytes = new byte[16];
        RANDOM.nextBytes(bytes);
        StringBuilder key = new StringBuilder("__hm");
        for (byte b : bytes) key.append(String.format("%02x", b));
        final String slot = key.toString();

        String wrapper = "(function(k,src){var s={d:0};"
            + "Object.defineProperty(window,k,{value:s,configurable:true});"
            + "function ok(v){try{var j=JSON.stringify(v);s.r={ok:true,json:j===undefined?null:j}}"
            + "catch(e){s.r={ok:false,message:'Result is not serializable: '+e}}s.d=1}"
            + "function bad(e){s.r={ok:false,message:String(e&&e.message||e)};s.d=1}"
            + "var v;try{v=(0,eval)(src)}catch(e){if(e instanceof EvalError){delete window[k];return 'csp'}bad(e);return 'done'}"
            + "if(v&&typeof v.then==='function'){v.then(ok,bad);return 'pending'}ok(v);return 'done'})("
            + JSONObject.quote(slot) + "," + JSONObject.quote(code) + ")";

        view.evaluateJavascript(wrapper, raw -> {
            if (p.finished) return;
            if ("\"csp\"".equals(raw)) {
                view.evaluateJavascript(code, value -> p.finish(true, "null".equals(value) ? null : value, null));
            } else {
                poll(p, slot, 20);
            }
        });
    }

    private void poll(final Pending p, final String slot, final long delayMs) {
        view.postDelayed(() -> {
            if (p.finished || destroyed) return;
            String script = "(function(k){var s=window[k];if(!s)return 'gone';if(!s.d)return null;"
                + "delete window[k];return JSON.stringify(s.r)})(" + JSONObject.quote(slot) + ")";
            view.evaluateJavascript(script, raw -> {
                if (p.finished) return;
                Object value = parse(raw);
                if (value == null) {
                    poll(p, slot, Math.min(delayMs * 2, 250));
                } else if ("gone".equals(value)) {
                    p.finish(false, null, "The page navigated before the script finished.");
                } else {
                    try {
                        JSONObject result = new JSONObject((String) value);
                        p.finish(result.optBoolean("ok"), result.isNull("json") ? null : result.optString("json"),
                            result.optString("message", null));
                    } catch (Exception e) {
                        p.finish(false, null, "Unreadable script result.");
                    }
                }
            });
        }, delayMs);
    }

    /** evaluateJavascript hands back JSON text: a quoted string, or null. */
    private static Object parse(String raw) {
        if (raw == null || raw.equals("null")) return null;
        try {
            Object value = new JSONTokener(raw).nextValue();
            return value instanceof String ? value : null;
        } catch (Exception e) {
            return null;
        }
    }
}

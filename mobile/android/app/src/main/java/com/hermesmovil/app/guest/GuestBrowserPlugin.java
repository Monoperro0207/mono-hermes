package com.hermesmovil.app.guest;

import android.view.ViewGroup;
import android.webkit.WebView;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import java.util.HashMap;
import java.util.Map;
import org.json.JSONObject;

/**
 * Capacitor bridge for the in-app browser. Each guest is a hardened {@link GuestWebView} added as a
 * sibling of the bridge WebView and positioned over the rect the renderer's shim reports (CSS px;
 * converted here with the display density). Everything touching a view runs on the UI thread.
 *
 * At most {@link #MAX_LIVE} guests exist: creating one more destroys the least recently visible, and
 * the renderer rebuilds it by URL when it is shown again (page state is lost, history too).
 */
@CapacitorPlugin(name = "GuestBrowser")
public class GuestBrowserPlugin extends Plugin implements GuestWebView.Listener {
    static final int MAX_LIVE = 4;

    private final Map<Integer, GuestWebView> guests = new HashMap<>();

    private interface Job {
        void run(PluginCall call) throws Exception;
    }

    private void ui(PluginCall call, Job job) {
        getActivity().runOnUiThread(() -> {
            try {
                job.run(call);
            } catch (Throwable e) {
                call.reject(String.valueOf(e.getMessage()));
            }
        });
    }

    /** The guest for the call's id, or null after rejecting the call. */
    private GuestWebView guest(PluginCall call) {
        Integer id = call.getInt("id");
        GuestWebView g = id == null ? null : guests.get(id);
        if (g == null) call.reject("No such guest");
        return g;
    }

    @Override
    public void onEvent(GuestWebView guest, String type, JSObject extra) {
        notifyListeners("guest", extra);
    }

    @Override
    public void onRenderProcessGone(GuestWebView guest) {
        guests.remove(guest.id);
        guest.destroy();
        notifyListeners("guest", guest.stateEvent("gone", null));
    }

    @Override
    protected void handleOnPause() {
        super.handleOnPause();
        for (GuestWebView g : guests.values()) g.onPause();
    }

    @Override
    protected void handleOnResume() {
        super.handleOnResume();
        for (GuestWebView g : guests.values()) g.onResume();
    }

    @Override
    protected void handleOnDestroy() {
        super.handleOnDestroy();
        for (GuestWebView g : guests.values()) g.destroy();
        guests.clear();
    }

    @PluginMethod
    public void create(PluginCall call) {
        Integer id = call.getInt("id");
        String url = call.getString("url");
        if (id == null || url == null) {
            call.reject("id and url are required");
            return;
        }
        ui(call, c -> {
            if (guests.containsKey(id)) {
                c.resolve();
                return;
            }
            evictOldest();
            WebView host = getBridge().getWebView();
            GuestWebView g = new GuestWebView(getContext(), id, this);
            // Created at the host's size, not 1x1: a page that loads into a tiny hidden view never paints its
            // content once the view is resized and shown (only the page background appears).
            ((ViewGroup) host.getParent()).addView(g.view, new ViewGroup.LayoutParams(Math.max(1, host.getWidth()), Math.max(1, host.getHeight())));
            guests.put(id, g);
            String refusal = g.load(url);
            if (refusal != null) {
                g.view.loadUrl(GuestUrlPolicy.ABOUT_BLANK);
                g.reportBlocked(url, refusal);
            }
            c.resolve();
        });
    }

    private void evictOldest() {
        if (guests.size() < MAX_LIVE) return;
        GuestWebView oldest = null;
        for (GuestWebView g : guests.values()) {
            if (oldest == null || (!g.visible && oldest.visible) || (g.visible == oldest.visible && g.lastVisibleAt < oldest.lastVisibleAt)) {
                oldest = g;
            }
        }
        if (oldest == null) return;
        guests.remove(oldest.id);
        oldest.destroy();
        notifyListeners("guest", oldest.stateEvent("evicted", null));
    }

    @PluginMethod
    public void destroy(PluginCall call) {
        Integer id = call.getInt("id");
        ui(call, c -> {
            GuestWebView g = id == null ? null : guests.remove(id);
            if (g != null) g.destroy();
            c.resolve();
        });
    }

    @PluginMethod
    public void setBounds(PluginCall call) {
        ui(call, c -> {
            GuestWebView g = guest(c);
            if (g == null) return;
            boolean show = Boolean.TRUE.equals(c.getBoolean("visible"));
            float density = getContext().getResources().getDisplayMetrics().density;
            WebView host = getBridge().getWebView();
            int left = Math.round((float) (double) c.getDouble("x", 0.0) * density + host.getX());
            int top = Math.round((float) (double) c.getDouble("y", 0.0) * density + host.getY());
            int width = Math.max(1, Math.round((float) (double) c.getDouble("width", 1.0) * density));
            int height = Math.max(1, Math.round((float) (double) c.getDouble("height", 1.0) * density));
            g.place(show, left, top, width, height);
            c.resolve();
        });
    }

    @PluginMethod
    public void loadUrl(PluginCall call) {
        String url = call.getString("url");
        ui(call, c -> {
            GuestWebView g = guest(c);
            if (g == null) return;
            String refusal = g.load(url);
            if (refusal != null) c.reject(refusal, "blocked");
            else c.resolve();
        });
    }

    @PluginMethod
    public void navigate(PluginCall call) {
        String action = call.getString("action", "reload");
        ui(call, c -> {
            GuestWebView g = guest(c);
            if (g == null) return;
            g.navigate(action);
            c.resolve();
        });
    }

    @PluginMethod
    public void evaluate(PluginCall call) {
        String code = call.getString("code");
        long timeoutMs = call.getLong("timeoutMs", 60_000L);
        ui(call, c -> {
            GuestWebView g = guest(c);
            if (g == null) return;
            if (code == null) {
                c.reject("code is required");
                return;
            }
            g.evaluate(code, timeoutMs, (ok, json, message) -> {
                JSObject out = new JSObject();
                out.put("ok", ok);
                out.put("json", json);
                if (message != null) out.put("message", message);
                c.resolve(out);
            });
        });
    }

    @PluginMethod
    public void injectInput(PluginCall call) {
        JSONObject event = call.getObject("event");
        ui(call, c -> {
            GuestWebView g = guest(c);
            if (g == null) return;
            if (event != null) g.input.dispatch(event);
            c.resolve();
        });
    }

    @PluginMethod
    public void setMuted(PluginCall call) {
        boolean muted = Boolean.TRUE.equals(call.getBoolean("muted"));
        ui(call, c -> {
            GuestWebView g = guest(c);
            if (g == null) return;
            g.setMuted(muted);
            c.resolve();
        });
    }

    @PluginMethod
    public void focus(PluginCall call) {
        ui(call, c -> {
            GuestWebView g = guest(c);
            if (g == null) return;
            g.view.requestFocus();
            c.resolve();
        });
    }
}

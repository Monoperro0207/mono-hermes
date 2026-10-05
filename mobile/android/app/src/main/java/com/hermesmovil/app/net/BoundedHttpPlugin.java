package com.hermesmovil.app.net;

import android.os.StatFs;
import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import java.io.File;
import java.util.HashMap;
import java.util.Iterator;
import java.util.Map;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.RejectedExecutionException;

/**
 * Capacitor bridge for {@link BoundedFetcher}. Capacitor runs every plugin method on one shared
 * "CapacitorPlugins" HandlerThread, so blocking network work goes to a small private pool instead
 * of stalling every other plugin call.
 */
@CapacitorPlugin(name = "BoundedHttp")
public class BoundedHttpPlugin extends Plugin {
    private final ExecutorService executor = Executors.newFixedThreadPool(4);
    private BoundedFetcher fetcher;

    private synchronized BoundedFetcher fetcher() {
        if (fetcher == null) fetcher = BoundedFetcher.create(dir -> new StatFs(dir.getPath()).getAvailableBytes());
        return fetcher;
    }

    @Override
    protected void handleOnDestroy() {
        super.handleOnDestroy();
        executor.shutdownNow();
    }

    private interface Job {
        void run(PluginCall call) throws Exception;
    }

    private void async(PluginCall call, Job job) {
        try {
            executor.execute(() -> {
                try {
                    job.run(call);
                } catch (BoundedFetcher.FetchException e) {
                    call.reject(e.getMessage(), e.code);
                } catch (Throwable e) {
                    // Throwable, not Exception: an Error must still settle the JS promise.
                    call.reject(String.valueOf(e.getMessage()), BoundedFetcher.NETWORK);
                }
            });
        } catch (RejectedExecutionException e) {
            call.reject("plugin destroyed", BoundedFetcher.NETWORK);
        }
    }

    @PluginMethod
    public void fetchPublicText(PluginCall call) {
        String url = call.getString("url");
        Integer maxBytes = call.getInt("maxBytes");
        Integer maxRedirects = call.getInt("maxRedirects", RequestLimits.TEXT_MAX_REDIRECTS);
        if (url == null || !RequestLimits.validText(maxBytes, maxRedirects)) {
            call.reject("url, maxBytes (1.." + RequestLimits.TEXT_MAX_BYTES + ") and maxRedirects (0.."
                + RequestLimits.TEXT_MAX_REDIRECTS + ") are required", BoundedFetcher.INVALID_REQUEST);
            return;
        }
        String accept = call.getString("accept");
        async(call, c -> {
            BoundedFetcher.TextResult r = fetcher().fetchPublicText(url, maxBytes, maxRedirects, accept);
            JSObject out = new JSObject();
            out.put("status", r.status);
            out.put("url", r.url);
            out.put("contentType", r.contentType);
            out.put("text", r.text);
            out.put("truncated", r.truncated);
            c.resolve(out);
        });
    }

    @PluginMethod
    public void download(PluginCall call) {
        String url = call.getString("url");
        Double maxBytesRaw = call.getDouble("maxBytes");
        String fileName = call.getString("fileName");
        String directory = call.getString("directory");
        File dir = resolveDir(directory);
        boolean publicOnly = call.getBoolean("publicOnly", false);
        if (url == null || dir == null || !validName(fileName) || !RequestLimits.validDownload(maxBytesRaw, directory, publicOnly)) {
            call.reject("invalid download request", BoundedFetcher.INVALID_REQUEST);
            return;
        }
        long maxBytes = maxBytesRaw.longValue();
        Map<String, String> headers = new HashMap<>();
        JSObject rawHeaders = call.getObject("headers");
        if (rawHeaders != null) {
            Iterator<String> keys = rawHeaders.keys();
            while (keys.hasNext()) {
                String key = keys.next();
                String value = rawHeaders.getString(key);
                if (value != null) headers.put(key, value);
            }
        }
        async(call, c -> {
            dir.mkdirs();
            // Free space is checked by the fetcher against the real size, not against the ceiling.
            BoundedFetcher.DownloadResult r = fetcher().download(url, headers, maxBytes, new File(dir, fileName), publicOnly);
            JSObject out = new JSObject();
            out.put("status", r.status);
            out.put("path", r.path == null ? JSObject.NULL : r.path);
            out.put("uri", r.path == null ? "" : "file://" + r.path);
            out.put("bytes", r.bytes);
            out.put("contentType", r.contentType == null ? JSObject.NULL : r.contentType);
            out.put("contentDisposition", r.contentDisposition == null ? JSObject.NULL : r.contentDisposition);
            out.put("errorBody", r.errorBody == null ? JSObject.NULL : r.errorBody);
            c.resolve(out);
        });
    }

    @PluginMethod
    public void deleteFiles(PluginCall call) {
        File dir = resolveDir(call.getString("directory"));
        if (dir == null) {
            call.reject("directory must be media or downloads", BoundedFetcher.INVALID_REQUEST);
            return;
        }
        JSArray names = call.getArray("names");
        long olderThanMs = call.getLong("olderThanMs", 0L);
        String[] selected = null;
        if (names != null) {
            selected = new String[names.length()];
            for (int i = 0; i < selected.length; i++) {
                String name = names.optString(i, null);
                if (!validName(name)) {
                    call.reject("invalid file name", BoundedFetcher.INVALID_REQUEST);
                    return;
                }
                selected[i] = name;
            }
        }
        final String[] only = selected;
        async(call, c -> {
            int deleted = 0;
            if (only != null) {
                for (String name : only) {
                    File f = new File(dir, name);
                    if (f.isFile() && f.delete()) deleted++;
                }
            } else {
                File[] files = dir.listFiles();
                long cutoff = System.currentTimeMillis() - olderThanMs;
                if (files != null) {
                    for (File f : files) {
                        if (f.isFile() && f.lastModified() <= cutoff && f.delete()) deleted++;
                    }
                }
            }
            JSObject out = new JSObject();
            out.put("deleted", deleted);
            c.resolve(out);
        });
    }

    /** Only two fixed sub-directories of the app cache are reachable: no caller-supplied paths. */
    private File resolveDir(String directory) {
        if (!"media".equals(directory) && !"downloads".equals(directory)) return null;
        return new File(getContext().getCacheDir(), directory);
    }

    /** A plain single path segment: no separators, no traversal, no NUL. */
    static boolean validName(String name) {
        if (name == null || name.isEmpty() || name.equals(".") || name.equals("..")) return false;
        return name.indexOf('/') < 0 && name.indexOf('\\') < 0 && name.indexOf('\0') < 0;
    }
}

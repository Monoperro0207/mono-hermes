package com.hermesmovil.app.net;

import java.io.File;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.InterruptedIOException;
import java.net.InetAddress;
import java.net.InetSocketAddress;
import java.net.Proxy;
import java.net.SocketTimeoutException;
import java.net.UnknownHostException;
import java.nio.charset.Charset;
import java.nio.charset.StandardCharsets;
import java.util.Collections;
import java.util.HashMap;
import java.util.Locale;
import java.util.Map;
import java.util.Set;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.TimeUnit;
import java.util.function.Predicate;
import okhttp3.Call;
import okhttp3.Dns;
import okhttp3.EventListener;
import okhttp3.HttpUrl;
import okhttp3.MediaType;
import okhttp3.OkHttpClient;
import okhttp3.Request;
import okhttp3.Response;
import okhttp3.ResponseBody;
import okio.Buffer;
import okio.BufferedSource;

/**
 * HTTP fetches whose byte caps are enforced WHILE streaming (a response is never fully buffered,
 * unlike CapacitorHttp) and whose public-web variant only ever connects to addresses validated by
 * {@link PublicOnlyDns}. Pure Java + OkHttp so it is unit-testable on the JVM.
 */
public final class BoundedFetcher {
    public static final String TOO_LARGE = "too_large";
    public static final String BLOCKED_HOST = "blocked_host";
    public static final String TIMEOUT = "timeout";
    public static final String INSUFFICIENT_SPACE = "insufficient_space";
    public static final String INVALID_REQUEST = "invalid_request";
    public static final String NETWORK = "network";

    private static final int CHUNK = 64 * 1024;
    private static final int ERROR_BODY_MAX = 4096;
    private static final int DOWNLOAD_PUBLIC_MAX_REDIRECTS = 3;
    private static final String[] CREDENTIAL_HEADERS = {"authorization", "cookie", "proxy-authorization"};

    /** Failure with a stable machine-readable {@link #code} the JS side maps to user messages. */
    public static final class FetchException extends IOException {
        public final String code;

        public FetchException(String code) {
            super(code);
            this.code = code;
        }

        public FetchException(String code, Throwable cause) {
            super(code, cause);
            this.code = code;
        }
    }

    public static final class TextResult {
        public final int status;
        public final String url;
        public final String contentType;
        public final String text;
        public final boolean truncated;

        public TextResult(int status, String url, String contentType, String text, boolean truncated) {
            this.status = status;
            this.url = url;
            this.contentType = contentType;
            this.text = text;
            this.truncated = truncated;
        }
    }

    public static final class DownloadResult {
        public final int status;
        public final String path;
        public final long bytes;
        public final String contentType;
        public final String contentDisposition;
        public final String errorBody;

        public DownloadResult(int status, String path, long bytes, String contentType, String contentDisposition, String errorBody) {
            this.status = status;
            this.path = path;
            this.bytes = bytes;
            this.contentType = contentType;
            this.contentDisposition = contentDisposition;
            this.errorBody = errorBody;
        }
    }

    /** Belt and braces: re-asserts the policy on the address OkHttp is actually about to dial. */
    private static final class PolicyListener extends EventListener {
        private final Predicate<InetAddress> policy;
        private final Set<Call> blocked;

        PolicyListener(Predicate<InetAddress> policy, Set<Call> blocked) {
            this.policy = policy;
            this.blocked = blocked;
        }

        @Override
        public void connectStart(Call call, InetSocketAddress inetSocketAddress, Proxy proxy) {
            InetAddress a = inetSocketAddress.getAddress();
            if (a == null || !policy.test(a)) {
                // A listener cannot throw a checked IOException; cancelling fails the call with an
                // IOException, and the recorded call lets us report it as blocked_host.
                blocked.add(call);
                call.cancel();
            }
        }
    }

    private final OkHttpClient publicClient;
    private final OkHttpClient gatewayClient;
    private final Set<Call> blockedCalls = Collections.newSetFromMap(new ConcurrentHashMap<>());

    public static BoundedFetcher create() {
        return new BoundedFetcher(new PublicOnlyDns(), AddressPolicy::isPublic);
    }

    /** For tests: inject the address policy and the DNS the policy-enforcing resolver delegates to. */
    public BoundedFetcher(Predicate<InetAddress> policy, Dns delegateDns) {
        this(new PublicOnlyDns(delegateDns, policy), policy);
    }

    /** For tests: lets the DNS and the connect-time listener use different policies. */
    BoundedFetcher(Dns publicDns, Predicate<InetAddress> listenerPolicy) {
        this.publicClient = new OkHttpClient.Builder()
            .dns(publicDns)
            .proxy(Proxy.NO_PROXY)
            .followRedirects(false)
            .followSslRedirects(false)
            .connectTimeout(4, TimeUnit.SECONDS)
            .readTimeout(6, TimeUnit.SECONDS)
            .callTimeout(10, TimeUnit.SECONDS)
            .eventListener(new PolicyListener(listenerPolicy, blockedCalls))
            .build();
        // The user's own gateway (LAN / Tailscale): default DNS, redirects allowed. OkHttp strips the
        // Authorization header when a redirect leaves the original host.
        this.gatewayClient = new OkHttpClient.Builder()
            .followRedirects(true)
            .followSslRedirects(true)
            .connectTimeout(10, TimeUnit.SECONDS)
            .readTimeout(30, TimeUnit.SECONDS)
            .build();
    }

    // ---------------------------------------------------------------- text

    public TextResult fetchPublicText(String url, int maxBytes, int maxRedirects, String accept) throws FetchException {
        HttpUrl current = validatePublicUrl(url);
        String acceptHeader = accept == null || accept.isEmpty() ? "text/html" : accept;
        int hops = 0;
        while (true) {
            Request request = new Request.Builder()
                .url(current)
                .header("Accept", acceptHeader)
                // Only a hint: servers may ignore it, the cap below is what actually bounds the read.
                .header("Range", "bytes=0-" + Math.max(0, maxBytes - 1))
                .build();
            Call call = publicClient.newCall(request);
            try (Response response = call.execute()) {
                int status = response.code();
                String location = response.header("Location");
                if (isRedirect(status) && location != null) {
                    if (hops >= maxRedirects) return new TextResult(status, current.toString(), "", "", false);
                    HttpUrl next = current.resolve(location);
                    if (next == null) throw new FetchException(INVALID_REQUEST);
                    current = validatePublicUrl(next.toString());
                    hops++;
                    continue; // closing the response without reading it cancels the body
                }
                String contentType = response.header("Content-Type");
                if (status >= 400 || contentType == null || !contentType.toLowerCase(Locale.ROOT).contains("text/html")) {
                    return new TextResult(status, current.toString(), contentType == null ? "" : contentType, "", false);
                }
                ResponseBody body = response.body();
                BufferedSource source = body.source();
                Buffer buffer = new Buffer();
                while (buffer.size() < maxBytes) {
                    long read = source.read(buffer, Math.min(8192L, maxBytes - buffer.size()));
                    if (read == -1) break;
                }
                boolean truncated = buffer.size() >= maxBytes && source.request(1);
                String text = buffer.readString(charsetOf(body.contentType()));
                return new TextResult(status, current.toString(), contentType, text, truncated);
            } catch (IOException e) {
                throw map(e, call);
            }
        }
    }

    // ------------------------------------------------------------ download

    public DownloadResult download(String url, Map<String, String> headers, long maxBytes, File destFile, boolean publicOnly)
        throws FetchException {
        File part = new File(destFile.getPath() + ".part");
        try {
            return doDownload(url, headers == null ? new HashMap<>() : headers, maxBytes, destFile, part, publicOnly);
        } catch (FetchException e) {
            part.delete();
            throw e;
        } catch (RuntimeException e) {
            part.delete();
            throw new FetchException(NETWORK, e);
        }
    }

    private DownloadResult doDownload(String url, Map<String, String> headers, long maxBytes, File destFile, File part, boolean publicOnly)
        throws FetchException {
        OkHttpClient client = publicOnly ? publicClient : gatewayClient;
        HttpUrl current = publicOnly ? validatePublicUrl(url) : parseHttpUrl(url);
        Map<String, String> currentHeaders = headers;
        int hops = 0;
        while (true) {
            Request.Builder rb = new Request.Builder().url(current);
            for (Map.Entry<String, String> h : currentHeaders.entrySet()) rb.header(h.getKey(), h.getValue());
            Call call = client.newCall(rb.build());
            try (Response response = call.execute()) {
                int status = response.code();
                String location = response.header("Location");
                if (publicOnly && isRedirect(status) && location != null) {
                    if (hops >= DOWNLOAD_PUBLIC_MAX_REDIRECTS) throw new FetchException(INVALID_REQUEST);
                    HttpUrl next = current.resolve(location);
                    if (next == null) throw new FetchException(INVALID_REQUEST);
                    next = validatePublicUrl(next.toString());
                    // Manual redirects must not carry credentials to another host.
                    if (!next.host().equalsIgnoreCase(current.host())) currentHeaders = withoutCredentials(currentHeaders);
                    current = next;
                    hops++;
                    continue;
                }
                String contentType = response.header("Content-Type");
                String disposition = response.header("Content-Disposition");
                ResponseBody body = response.body();
                if (status >= 400) {
                    return new DownloadResult(status, null, 0, contentType, disposition, readErrorBody(body));
                }
                String declared = response.header("Content-Length");
                if (declared != null) {
                    try {
                        if (Long.parseLong(declared.trim()) > maxBytes) throw new FetchException(TOO_LARGE);
                    } catch (NumberFormatException ignored) {
                        // Unparseable header: the streaming cap below still bounds the download.
                    }
                }
                File parent = destFile.getAbsoluteFile().getParentFile();
                if (parent != null) parent.mkdirs();
                long total = 0;
                try (InputStream in = body.byteStream(); FileOutputStream out = new FileOutputStream(part)) {
                    byte[] buf = new byte[CHUNK];
                    while (true) {
                        // Ask for one byte past the cap so exceeding it is detected immediately.
                        int want = (int) Math.min(buf.length, maxBytes - total + 1);
                        int n = in.read(buf, 0, want);
                        if (n == -1) break;
                        if (total + n > maxBytes) throw new FetchException(TOO_LARGE);
                        out.write(buf, 0, n);
                        total += n;
                    }
                }
                if (destFile.exists() && !destFile.delete()) throw new FetchException(NETWORK);
                if (!part.renameTo(destFile)) throw new FetchException(NETWORK);
                return new DownloadResult(status, destFile.getAbsolutePath(), total, contentType, disposition, null);
            } catch (IOException e) {
                throw map(e, call);
            }
        }
    }

    private static String readErrorBody(ResponseBody body) throws IOException {
        BufferedSource source = body.source();
        Buffer buffer = new Buffer();
        while (buffer.size() < ERROR_BODY_MAX) {
            long read = source.read(buffer, Math.min(1024L, ERROR_BODY_MAX - buffer.size()));
            if (read == -1) break;
        }
        return buffer.readString(StandardCharsets.UTF_8);
    }

    private static Map<String, String> withoutCredentials(Map<String, String> headers) {
        Map<String, String> out = new HashMap<>();
        for (Map.Entry<String, String> h : headers.entrySet()) {
            boolean sensitive = false;
            for (String name : CREDENTIAL_HEADERS) if (name.equalsIgnoreCase(h.getKey())) sensitive = true;
            if (!sensitive) out.put(h.getKey(), h.getValue());
        }
        return out;
    }

    // ------------------------------------------------------------- helpers

    static boolean isRedirect(int status) {
        return status == 301 || status == 302 || status == 303 || status == 307 || status == 308;
    }

    /** http/https only, and (for public fetches) no embedded credentials. */
    static HttpUrl validatePublicUrl(String url) throws FetchException {
        HttpUrl parsed = parseHttpUrl(url);
        if (!parsed.username().isEmpty() || !parsed.password().isEmpty()) throw new FetchException(INVALID_REQUEST);
        return parsed;
    }

    static HttpUrl parseHttpUrl(String url) throws FetchException {
        HttpUrl parsed = url == null ? null : HttpUrl.parse(url);
        if (parsed == null) throw new FetchException(INVALID_REQUEST);
        String scheme = parsed.scheme();
        if (!scheme.equals("http") && !scheme.equals("https")) throw new FetchException(INVALID_REQUEST);
        return parsed;
    }

    static Charset charsetOf(MediaType type) {
        try {
            return type == null ? StandardCharsets.UTF_8 : type.charset(StandardCharsets.UTF_8);
        } catch (RuntimeException e) { // unsupported / illegal charset name
            return StandardCharsets.UTF_8;
        }
    }

    /** Maps a transport failure to a stable error code; walks causes because OkHttp may wrap them. */
    private FetchException map(IOException e, Call call) {
        if (e instanceof FetchException) return (FetchException) e;
        if (blockedCalls.remove(call)) return new FetchException(BLOCKED_HOST, e);
        for (Throwable t = e; t != null; t = t.getCause()) {
            String message = t.getMessage();
            if (t instanceof UnknownHostException && message != null && message.startsWith(PublicOnlyDns.BLOCKED_PREFIX)) {
                return new FetchException(BLOCKED_HOST, e);
            }
        }
        for (Throwable t = e; t != null; t = t.getCause()) {
            String message = t.getMessage();
            if (message != null && (message.contains("ENOSPC") || message.contains("No space left"))) {
                return new FetchException(INSUFFICIENT_SPACE, e);
            }
        }
        if (e instanceof SocketTimeoutException || e instanceof InterruptedIOException) return new FetchException(TIMEOUT, e);
        return new FetchException(NETWORK, e);
    }
}

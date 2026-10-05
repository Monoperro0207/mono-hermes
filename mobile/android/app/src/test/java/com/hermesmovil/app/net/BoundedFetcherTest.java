package com.hermesmovil.app.net;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertTrue;
import static org.junit.Assert.fail;

import com.hermesmovil.app.net.BoundedFetcher.DownloadResult;
import com.hermesmovil.app.net.BoundedFetcher.FetchException;
import com.hermesmovil.app.net.BoundedFetcher.TextResult;
import java.io.File;
import java.net.InetAddress;
import java.net.UnknownHostException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.util.Arrays;
import java.util.Collections;
import java.util.HashMap;
import java.util.Map;
import okhttp3.Dns;
import okhttp3.mockwebserver.MockResponse;
import okhttp3.mockwebserver.MockWebServer;
import okhttp3.mockwebserver.RecordedRequest;
import okio.Buffer;
import org.junit.After;
import org.junit.Before;
import org.junit.Rule;
import org.junit.Test;
import org.junit.rules.TemporaryFolder;

public class BoundedFetcherTest {
    @Rule public TemporaryFolder tmp = new TemporaryFolder();

    private MockWebServer server;
    private BoundedFetcher fetcher;
    private int port;

    /** public.test -> the mock server (loopback); private.test -> 10.0.0.1. */
    private static final Dns FAKE_DNS = host -> {
        try {
            if (host.equals("public.test")) return Collections.singletonList(InetAddress.getByName("127.0.0.1"));
            if (host.equals("private.test")) return Collections.singletonList(InetAddress.getByName("10.0.0.1"));
        } catch (UnknownHostException e) {
            throw new AssertionError(e);
        }
        throw new UnknownHostException(host);
    };

    @Before
    public void setUp() throws Exception {
        server = new MockWebServer();
        server.start(InetAddress.getByName("127.0.0.1"), 0);
        port = server.getPort();
        // Test policy: loopback (the mock) is allowed, 10/8 is rejected.
        fetcher = new BoundedFetcher(a -> a.isLoopbackAddress(), FAKE_DNS);
    }

    @After
    public void tearDown() throws Exception {
        server.shutdown();
    }

    private String url(String host, String path) {
        return "http://" + host + ":" + port + path;
    }

    private static Buffer bytes(int n, byte fill) {
        byte[] data = new byte[n];
        Arrays.fill(data, fill);
        return new Buffer().write(data);
    }

    // ----------------------------------------------------------------- text

    @Test
    public void textIsCappedWhileStreaming() throws Exception {
        Buffer body = new Buffer().writeUtf8("<html><head><title>Hello</title></head><body>");
        body.writeAll(bytes(5 * 1024 * 1024, (byte) 'x'));
        server.enqueue(new MockResponse().setHeader("Content-Type", "text/html; charset=utf-8").setBody(body));

        TextResult r = fetcher.fetchPublicText(url("public.test", "/"), 64 * 1024, 3, null);

        assertEquals(200, r.status);
        assertTrue(r.text.length() <= 64 * 1024);
        assertTrue(r.text.length() > 60 * 1024);
        assertTrue(r.truncated);
        assertTrue(r.text.contains("<title>Hello</title>"));
        RecordedRequest req = server.takeRequest();
        assertEquals("bytes=0-65535", req.getHeader("Range"));
        assertEquals("text/html", req.getHeader("Accept"));
    }

    @Test
    public void smallHtmlIsNotTruncated() throws Exception {
        server.enqueue(new MockResponse().setHeader("Content-Type", "text/html").setBody("<title>x</title>"));
        TextResult r = fetcher.fetchPublicText(url("public.test", "/"), 64 * 1024, 3, "text/html,*/*");
        assertEquals("<title>x</title>", r.text);
        assertFalse(r.truncated);
        assertEquals("text/html,*/*", server.takeRequest().getHeader("Accept"));
    }

    @Test
    public void nonHtmlBodyIsNotRead() throws Exception {
        server.enqueue(new MockResponse().setHeader("Content-Type", "application/octet-stream").setBody(bytes(2 * 1024 * 1024, (byte) 1)));
        long start = System.nanoTime();
        TextResult r = fetcher.fetchPublicText(url("public.test", "/bin"), 64 * 1024, 3, null);
        assertEquals("", r.text);
        assertEquals(200, r.status);
        assertEquals("application/octet-stream", r.contentType);
        assertTrue("returned quickly", (System.nanoTime() - start) / 1_000_000 < 5000);
    }

    @Test
    public void errorStatusBodyIsNotRead() throws Exception {
        server.enqueue(new MockResponse().setResponseCode(404).setHeader("Content-Type", "text/html").setBody("<title>nope</title>"));
        TextResult r = fetcher.fetchPublicText(url("public.test", "/"), 64 * 1024, 3, null);
        assertEquals(404, r.status);
        assertEquals("", r.text);
    }

    @Test
    public void redirectToPrivateHostIsBlocked() throws Exception {
        server.enqueue(new MockResponse().setResponseCode(302).setHeader("Location", url("private.test", "/")));
        try {
            fetcher.fetchPublicText(url("public.test", "/"), 64 * 1024, 3, null);
            fail("expected blocked_host");
        } catch (FetchException e) {
            assertEquals("blocked_host", e.code);
        }
        assertEquals(1, server.getRequestCount());
    }

    @Test
    public void privateLiteralUrlIsBlocked() throws Exception {
        try {
            fetcher.fetchPublicText("http://10.1.2.3/", 1024, 3, null);
            fail("expected blocked_host");
        } catch (FetchException e) {
            assertEquals("blocked_host", e.code);
        }
    }

    @Test
    public void relativeRedirectIsFollowed() throws Exception {
        server.enqueue(new MockResponse().setResponseCode(301).setHeader("Location", "/final"));
        server.enqueue(new MockResponse().setHeader("Content-Type", "text/html").setBody("<title>ok</title>"));
        TextResult r = fetcher.fetchPublicText(url("public.test", "/start"), 1024, 3, null);
        assertEquals("<title>ok</title>", r.text);
        assertEquals(url("public.test", "/final"), r.url);
    }

    @Test
    public void tooManyRedirectsReturnsEmptyText() throws Exception {
        for (int i = 0; i < 4; i++) server.enqueue(new MockResponse().setResponseCode(302).setHeader("Location", "/r" + i));
        TextResult r = fetcher.fetchPublicText(url("public.test", "/"), 1024, 3, null);
        assertEquals("", r.text);
        assertEquals(302, r.status);
        assertEquals(4, server.getRequestCount());
    }

    @Test
    public void invalidUrlsAreRejected() throws Exception {
        String[] bad = {"file:///etc/passwd", "http://user:pw@public.test/", "ftp://public.test/", "not a url", ""};
        for (String u : bad) {
            try {
                fetcher.fetchPublicText(u, 1024, 3, null);
                fail("expected invalid_request for " + u);
            } catch (FetchException e) {
                assertEquals("invalid_request", e.code);
            }
        }
    }

    @Test
    public void connectTimeListenerBlocksDisallowedAddress() throws Exception {
        // DNS lets loopback through unvalidated; the connect-time check must still refuse it.
        BoundedFetcher strict = new BoundedFetcher(FAKE_DNS, a -> !a.isLoopbackAddress());
        try {
            strict.fetchPublicText(url("public.test", "/"), 1024, 3, null);
            fail("expected blocked_host");
        } catch (FetchException e) {
            assertEquals("blocked_host", e.code);
        }
        assertEquals(0, server.getRequestCount());
    }

    // ------------------------------------------------------------- download

    private File dest() {
        return new File(tmp.getRoot(), "out.bin");
    }

    private void assertNoFiles() {
        assertFalse(dest().exists());
        assertFalse(new File(dest().getPath() + ".part").exists());
    }

    @Test
    public void chunkedBodyOverCapIsTooLarge() throws Exception {
        long max = 100 * 1024;
        server.enqueue(new MockResponse().setChunkedBody(bytes((int) max + 1, (byte) 7), 8192));
        try {
            fetcher.download(url("public.test", "/f"), null, max, dest(), true);
            fail("expected too_large");
        } catch (FetchException e) {
            assertEquals("too_large", e.code);
        }
        assertNoFiles();
    }

    @Test
    public void declaredContentLengthOverCapIsTooLarge() throws Exception {
        server.enqueue(new MockResponse().setBody(bytes(10_000, (byte) 7)));
        try {
            fetcher.download(url("public.test", "/f"), null, 5_000, dest(), true);
            fail("expected too_large");
        } catch (FetchException e) {
            assertEquals("too_large", e.code);
        }
        assertNoFiles();
    }

    @Test
    public void downloadExactlyMaxBytesSucceeds() throws Exception {
        long max = 70_000; // spans more than one 64 KiB chunk
        server.enqueue(new MockResponse().setHeader("Content-Type", "image/png")
            .setHeader("Content-Disposition", "attachment; filename=a.png").setChunkedBody(bytes((int) max, (byte) 9), 4096));
        DownloadResult r = fetcher.download(url("public.test", "/f"), null, max, dest(), true);
        assertEquals(200, r.status);
        assertEquals(max, r.bytes);
        assertEquals(max, dest().length());
        assertEquals(dest().getAbsolutePath(), r.path);
        assertEquals("image/png", r.contentType);
        assertEquals("attachment; filename=a.png", r.contentDisposition);
        assertFalse(new File(dest().getPath() + ".part").exists());
    }

    @Test
    public void downloadReplacesExistingFile() throws Exception {
        Files.write(dest().toPath(), "old old old".getBytes(StandardCharsets.UTF_8));
        server.enqueue(new MockResponse().setBody("new"));
        DownloadResult r = fetcher.download(url("public.test", "/f"), null, 1024, dest(), true);
        assertEquals(3, r.bytes);
        assertEquals("new", new String(Files.readAllBytes(dest().toPath()), StandardCharsets.UTF_8));
    }

    @Test
    public void errorStatusReturnsBodyWithoutThrowing() throws Exception {
        server.enqueue(new MockResponse().setResponseCode(401).setBody("{\"error\":\"expired\"}"));
        DownloadResult r = fetcher.download(url("public.test", "/f"), null, 1024, dest(), true);
        assertEquals(401, r.status);
        assertNull(r.path);
        assertEquals(0, r.bytes);
        assertTrue(r.errorBody.contains("expired"));
        assertNoFiles();
    }

    @Test
    public void errorBodyIsCapped() throws Exception {
        server.enqueue(new MockResponse().setResponseCode(500).setBody(bytes(100_000, (byte) 'e')));
        DownloadResult r = fetcher.download(url("public.test", "/f"), null, 1024, dest(), true);
        assertEquals(500, r.status);
        assertEquals(4096, r.errorBody.length());
    }

    @Test
    public void gatewayDownloadSendsHeaders() throws Exception {
        server.enqueue(new MockResponse().setBody("hello"));
        Map<String, String> headers = new HashMap<>();
        headers.put("Authorization", "Bearer x");
        // The gateway client uses the system DNS, so address the mock server directly (loopback is
        // fine there: only the public client enforces the address policy).
        DownloadResult r = fetcher.download("http://127.0.0.1:" + port + "/f", headers, 1024, dest(), false);
        assertEquals(200, r.status);
        assertEquals(5, r.bytes);
        assertEquals("Bearer x", server.takeRequest().getHeader("Authorization"));
    }

    @Test
    public void publicDownloadRedirectToPrivateHostIsBlocked() throws Exception {
        server.enqueue(new MockResponse().setResponseCode(302).setHeader("Location", url("private.test", "/f")));
        try {
            fetcher.download(url("public.test", "/f"), null, 1024, dest(), true);
            fail("expected blocked_host");
        } catch (FetchException e) {
            assertEquals("blocked_host", e.code);
        }
        assertNoFiles();
    }

    @Test
    public void publicDownloadRedirectDropsCredentialsOnHostChange() throws Exception {
        // Two names for the same server: the second hop is a different host.
        Dns anyToLoopback = host -> Collections.singletonList(InetAddress.getByName("127.0.0.1"));
        BoundedFetcher f = new BoundedFetcher(a -> a.isLoopbackAddress(), anyToLoopback);
        server.enqueue(new MockResponse().setResponseCode(302).setHeader("Location", url("other.test", "/f")));
        server.enqueue(new MockResponse().setBody("ok"));
        Map<String, String> headers = new HashMap<>();
        headers.put("Authorization", "Bearer secret");
        f.download(url("public.test", "/f"), headers, 1024, dest(), true);
        assertEquals("Bearer secret", server.takeRequest().getHeader("Authorization"));
        assertNull(server.takeRequest().getHeader("Authorization"));
    }
}

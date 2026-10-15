package com.hermesmovil.app.guest;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

import org.junit.Test;

public class GuestUrlPolicyTest {
    private static final String[] ALLOWED = {
        "https://example.com/a?b=1#c", "HTTPS://Example.com", "https://[2606:4700::1111]/", "https://example.com:8443/",
        "http://localhost:3000/", "http://dev.localhost/", "http://127.0.0.1:8080", "http://127.1/", "http://[::1]:5173/",
        "http://[0:0:0:0:0:0:0:1]/", "http://100.64.0.1/", "http://100.127.255.255/", "http://my-pc.tail1234.ts.net:9119/",
        "http://my-pc/", "http://192.168.1.20/x", "http://10.0.0.5", "http://172.16.0.1", "http://172.31.255.255",
        "http://169.254.1.1", "http://printer.local/", "http://2130706433/", "http://0x7f.0.0.1/", "http://0177.0.0.1/",
        "http://localhost./", "http://LOCALHOST/", "about:blank", "  https://example.com/  ",
    };

    private static final String[] PLAIN_HTTP_PUBLIC = {
        "http://example.com/", "http://8.8.8.8/", "http://100.128.0.1/", "http://100.63.255.255/", "http://172.32.0.1/",
        "http://172.15.0.1/", "http://192.169.0.1/", "http://[fd00::1]/", "http://[::ffff:127.0.0.1]/", "http://[2606:4700::1111]/",
        "http://134744072/", "http://0x8.8.8.8/", "http://localhost.example.com/", "http://notlocalhost.com/",
        "http://example.ts.net.evil.com/", "http://xn--e1afmkfd.xn--p1ai/", "http://١٢٧.0.0.1/",
        "http://%31%32%37.0.0.1/", "http://256.1.1.1/", "http://1.2.3.4.5/", "http://[::1%25lo]/",
    };

    private static final String[] BAD_SCHEME = {
        "file:///etc/passwd", "content://media/external/images", "intent://scan/#Intent;scheme=zxing;end", "market://details?id=x",
        "javascript:alert(1)", "data:text/html,hi", "blob:https://example.com/uuid", "ftp://example.com/", "chrome://version",
        "view-source:https://example.com", "about:srcdoc", "ws://localhost:1/", "wss://example.com/", "tel:+123", "mailto:a@b.c",
        "FILE:///sdcard/x", "jAvAsCrIpT:alert(1)",
    };

    private static final String[] INVALID = {
        null, "", "   ", "example.com", "//example.com", "https:example.com", "https:/example.com", "https://", "https:///x",
        "https://exa\tmple.com", "https://exa mple.com","http://localhost:99999/", "http://localhost:abc/",
        "http://[::1/", "http://a:b:c/", ":foo", "http://localhost:80:80/",
    };

    @Test
    public void allowsExpectedUrls() {
        for (String url : ALLOWED) assertTrue(url, GuestUrlPolicy.check(url).allowed);
    }

    @Test
    public void refusesPlainHttpToPublicHosts() {
        for (String url : PLAIN_HTTP_PUBLIC) {
            GuestUrlPolicy.Verdict v = GuestUrlPolicy.check(url);
            assertFalse(url, v.allowed);
            assertEquals(url, GuestUrlPolicy.REASON_PLAIN_HTTP, v.reason);
        }
    }

    @Test
    public void refusesEveryOtherScheme() {
        for (String url : BAD_SCHEME) {
            GuestUrlPolicy.Verdict v = GuestUrlPolicy.check(url);
            assertFalse(url, v.allowed);
            assertEquals(url, GuestUrlPolicy.REASON_SCHEME, v.reason);
        }
    }

    @Test
    public void refusesMalformedUrls() {
        for (String url : INVALID) assertFalse(String.valueOf(url), GuestUrlPolicy.check(url).allowed);
    }

    @Test
    public void refusesCredentials() {
        for (String url : new String[] {"https://user:pw@example.com/", "http://localhost@example.com/", "http://user@localhost/"}) {
            GuestUrlPolicy.Verdict v = GuestUrlPolicy.check(url);
            assertFalse(url, v.allowed);
            assertEquals(url, GuestUrlPolicy.REASON_CREDENTIALS, v.reason);
        }
    }

    @Test
    public void backslashEndsTheAuthorityLikeChromium() {
        // Chromium reads http://localhost\@example.com/ as host "localhost", path "/@example.com/".
        assertTrue(GuestUrlPolicy.check("http://localhost\\@example.com/").allowed);
        // ...and http://example.com\@localhost/ as host "example.com": still public plain http.
        assertFalse(GuestUrlPolicy.check("http://example.com\\@localhost/").allowed);
    }

    @Test
    public void classifiesHostsLikeTheRendererPolicy() {
        assertEquals("loopback", GuestUrlPolicy.classifyHost("localhost"));
        assertEquals("loopback", GuestUrlPolicy.classifyHost("a.b.localhost"));
        assertEquals("loopback", GuestUrlPolicy.classifyHost("0.0.0.0"));
        assertEquals("loopback", GuestUrlPolicy.classifyHost("::1"));
        assertEquals("tailnet", GuestUrlPolicy.classifyHost("100.100.100.100"));
        assertEquals("tailnet", GuestUrlPolicy.classifyHost("box.tail.ts.net"));
        assertEquals("lan", GuestUrlPolicy.classifyHost("192.168.0.1"));
        assertEquals("lan", GuestUrlPolicy.classifyHost("224.0.0.1"));
        assertEquals("lan", GuestUrlPolicy.classifyHost("nas"));
        assertEquals("lan", GuestUrlPolicy.classifyHost("nas.local"));
        assertEquals("public", GuestUrlPolicy.classifyHost("example.com"));
        assertEquals("public", GuestUrlPolicy.classifyHost("1.1.1.1"));
        assertEquals("public", GuestUrlPolicy.classifyHost("::ffff:7f00:1"));
        assertEquals("public", GuestUrlPolicy.classifyHost("fe80::1"));
    }
}

package com.hermesmovil.app.guest;

import com.hermesmovil.app.net.AddressPolicy;
import java.net.InetAddress;
import java.util.Locale;

/**
 * Which URLs the in-app browser (guest WebView) may load. Authoritative: enforced on every explicit
 * load, every navigation and redirect (shouldOverrideUrlLoading) and every popup target. The renderer
 * mirrors it in src/guest-browser/policy.ts only to refuse early with the same wording.
 *
 *  - only http and https (plus the internal about:blank); file:, content:, intent:, javascript:, data:,
 *    blob:, ftp:, chrome:, view-source: and everything else is refused;
 *  - no credentials in the URL;
 *  - plain http only for loopback, tailnet (100.64/10, *.ts.net) and private-network hosts, the same
 *    buckets as classifyHost in src/bridge/util.ts; public hosts must use https.
 *
 * Pure Java (no android.*) so it runs on the JVM in unit tests. The parser is deliberately strict: it
 * refuses what it cannot classify with certainty (control characters, percent-escapes or non-ASCII in an
 * http host, a missing "//"), because Chromium would normalise those forms to something this class
 * might have judged differently.
 */
public final class GuestUrlPolicy {
    private GuestUrlPolicy() {}

    public static final String ABOUT_BLANK = "about:blank";
    public static final String REASON_INVALID = "Not a valid URL.";
    public static final String REASON_SCHEME = "Only http and https pages can be opened in the in-app browser.";
    public static final String REASON_CREDENTIALS = "URLs with embedded credentials are not allowed.";
    public static final String REASON_PLAIN_HTTP =
        "Plain http:// is only allowed for localhost, Tailscale and private-network hosts. Use https:// for public sites.";

    public static final class Verdict {
        public final boolean allowed;
        public final String reason;

        private Verdict(boolean allowed, String reason) {
            this.allowed = allowed;
            this.reason = reason;
        }

        static Verdict allow() {
            return new Verdict(true, null);
        }

        static Verdict refuse(String reason) {
            return new Verdict(false, reason);
        }
    }

    public static Verdict check(String raw) {
        if (raw == null) return Verdict.refuse(REASON_INVALID);
        String url = raw.trim();
        if (url.equals(ABOUT_BLANK)) return Verdict.allow();
        if (url.isEmpty()) return Verdict.refuse(REASON_INVALID);
        for (int i = 0; i < url.length(); i++) {
            char c = url.charAt(i);
            if (c <= 0x20 || c == 0x7f) return Verdict.refuse(REASON_INVALID);
        }

        int colon = url.indexOf(':');
        if (colon <= 0) return Verdict.refuse(REASON_INVALID);
        String scheme = url.substring(0, colon).toLowerCase(Locale.ROOT);
        boolean https = scheme.equals("https");
        if (!https && !scheme.equals("http")) return Verdict.refuse(REASON_SCHEME);
        if (!url.startsWith("//", colon + 1)) return Verdict.refuse(REASON_INVALID);

        // Authority ends at the first / ? # or backslash (Chromium treats \ as / for http(s)).
        int start = colon + 3;
        int end = start;
        while (end < url.length() && "/?#\\".indexOf(url.charAt(end)) < 0) end++;
        String authority = url.substring(start, end);
        if (authority.indexOf('@') >= 0) return Verdict.refuse(REASON_CREDENTIALS);

        String host;
        String port;
        if (authority.startsWith("[")) {
            int close = authority.indexOf(']');
            if (close < 0) return Verdict.refuse(REASON_INVALID);
            host = authority.substring(1, close);
            String rest = authority.substring(close + 1);
            if (!rest.isEmpty() && !rest.startsWith(":")) return Verdict.refuse(REASON_INVALID);
            port = rest.isEmpty() ? "" : rest.substring(1);
        } else {
            int c = authority.lastIndexOf(':');
            host = c < 0 ? authority : authority.substring(0, c);
            port = c < 0 ? "" : authority.substring(c + 1);
            if (host.indexOf(':') >= 0) return Verdict.refuse(REASON_INVALID);
        }
        if (host.isEmpty() || !validPort(port)) return Verdict.refuse(REASON_INVALID);

        if (https) return Verdict.allow();
        for (int i = 0; i < host.length(); i++) {
            char c = host.charAt(i);
            if (c >= 0x80 || c == '%') return Verdict.refuse(REASON_PLAIN_HTTP);
        }
        return classifyHost(host).equals("public") ? Verdict.refuse(REASON_PLAIN_HTTP) : Verdict.allow();
    }

    private static boolean validPort(String port) {
        if (port.isEmpty()) return true;
        if (port.length() > 5) return false;
        int v = 0;
        for (int i = 0; i < port.length(); i++) {
            char c = port.charAt(i);
            if (c < '0' || c > '9') return false;
            v = v * 10 + (c - '0');
        }
        return v <= 65535;
    }

    /** Mirror of classifyHost in src/bridge/util.ts: "loopback", "tailnet", "lan" or "public". */
    static String classifyHost(String hostname) {
        String host = hostname.toLowerCase(Locale.ROOT);
        if (host.endsWith(".")) host = host.substring(0, host.length() - 1);

        if (host.indexOf(':') >= 0) {
            // IPv6 literal: only ::1 is loopback, everything else (ULA, mapped, ...) counts as public.
            InetAddress a = AddressPolicy.parseLiteral(host);
            return a != null && isV6Loopback(a) ? "loopback" : "public";
        }
        if (host.equals("localhost") || host.endsWith(".localhost")) return "loopback";
        if (host.endsWith(".ts.net")) return "tailnet";
        if (host.endsWith(".local")) return "lan";

        int[] o = parseIpv4(host);
        if (o == INVALID_IPV4) return "public";
        if (o == null) return host.matches("[a-z0-9][a-z0-9-]*") ? "lan" : "public";

        int a = o[0];
        int b = o[1];
        if (a == 127 || a == 0) return "loopback";
        if (a == 100 && b >= 64 && b <= 127) return "tailnet";
        if (a == 10 || (a == 172 && b >= 16 && b <= 31) || (a == 192 && b == 168) || (a == 169 && b == 254) || a >= 224) {
            return "lan";
        }
        return "public";
    }

    private static final int[] INVALID_IPV4 = new int[0];

    /**
     * WHATWG IPv4 parsing, so decimal / hex / octal / short forms ("2130706433", "0x7f.1", "127.1")
     * classify like the address Chromium will really connect to. Returns null when the host is a name
     * (its last label is not a number) and INVALID_IPV4 when it looks numeric but is not an address.
     */
    private static int[] parseIpv4(String host) {
        String[] parts = host.split("\\.", -1);
        if (!endsInNumber(parts[parts.length - 1])) return null;
        if (parts.length > 4) return INVALID_IPV4;
        long[] n = new long[parts.length];
        for (int i = 0; i < parts.length; i++) {
            long v = parseIpv4Part(parts[i]);
            if (v < 0) return INVALID_IPV4;
            n[i] = v;
        }
        for (int i = 0; i < n.length - 1; i++) if (n[i] > 255) return INVALID_IPV4;
        long last = n[n.length - 1];
        if (last >= (1L << (8 * (5 - n.length)))) return INVALID_IPV4;
        long addr = last;
        for (int i = 0; i < n.length - 1; i++) addr += n[i] << (8 * (3 - i));
        return new int[] {(int) (addr >> 24) & 0xff, (int) (addr >> 16) & 0xff, (int) (addr >> 8) & 0xff, (int) addr & 0xff};
    }

    private static boolean endsInNumber(String part) {
        if (part.isEmpty()) return false;
        if (part.matches("[0-9]+")) return true;
        return part.matches("0[xX][0-9a-fA-F]*");
    }

    /** One IPv4 part in decimal, 0x hex or 0-prefixed octal; -1 when malformed or absurdly large. */
    private static long parseIpv4Part(String p) {
        if (p.isEmpty()) return -1;
        int radix = 10;
        String digits = p;
        if (p.length() >= 2 && (p.startsWith("0x") || p.startsWith("0X"))) {
            radix = 16;
            digits = p.substring(2);
        } else if (p.length() >= 2 && p.charAt(0) == '0') {
            radix = 8;
            digits = p.substring(1);
        }
        if (digits.isEmpty()) return 0;
        if (digits.length() > 12) return -1;
        try {
            return Long.parseLong(digits, radix);
        } catch (NumberFormatException e) {
            return -1;
        }
    }

    /** True only for a genuine 16-byte ::1 (an IPv4-mapped form comes back as a 4-byte address). */
    private static boolean isV6Loopback(InetAddress a) {
        byte[] b = a.getAddress();
        if (b.length != 16 || b[15] != 1) return false;
        for (int i = 0; i < 15; i++) if (b[i] != 0) return false;
        return true;
    }
}

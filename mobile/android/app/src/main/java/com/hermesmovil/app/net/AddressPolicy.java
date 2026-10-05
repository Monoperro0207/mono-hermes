package com.hermesmovil.app.net;

import java.net.InetAddress;
import java.net.UnknownHostException;

/**
 * Decides whether a resolved address belongs to the public internet. Used so that "link title"
 * fetches can never reach loopback, LAN, VPN (Tailscale CGNAT), link-local or other special-use
 * ranges, even when a public hostname resolves to one of them. Pure Java (no android.*) so it runs
 * on the JVM in unit tests.
 */
public final class AddressPolicy {
    private AddressPolicy() {}

    public static boolean isPublic(InetAddress a) {
        if (a == null) return false;
        byte[] b = a.getAddress();
        if (b.length == 4) return isPublicV4(b[0] & 0xff, b[1] & 0xff, b[2] & 0xff, b[3] & 0xff);
        if (b.length == 16) return isPublicV6(b);
        return false;
    }

    private static boolean isPublicV4(int a, int b, int c, int d) {
        if (a == 0) return false; // 0.0.0.0/8 "this network"
        if (a == 10) return false; // 10/8
        if (a == 127) return false; // loopback
        if (a == 100 && (b & 0xc0) == 64) return false; // 100.64/10 CGNAT (Tailscale)
        if (a == 169 && b == 254) return false; // link-local
        if (a == 172 && (b & 0xf0) == 16) return false; // 172.16/12
        if (a == 192 && b == 168) return false; // 192.168/16
        if (a == 192 && b == 0 && (c == 0 || c == 2)) return false; // 192.0.0/24, 192.0.2/24 (TEST-NET-1)
        if (a == 198 && (b & 0xfe) == 18) return false; // 198.18/15 benchmarking
        if (a == 198 && b == 51 && c == 100) return false; // TEST-NET-2
        if (a == 203 && b == 0 && c == 113) return false; // TEST-NET-3
        if (a >= 224) return false; // 224/4 multicast and 240/4 reserved (incl. 255.255.255.255)
        return true;
    }

    private static boolean isPublicV6(byte[] b) {
        int b0 = b[0] & 0xff;
        int b1 = b[1] & 0xff;
        // ::/96 covers :: (any-local), ::1 (loopback) and IPv4-compatible addresses: all rejected.
        if (allZero(b, 0, 12)) return false;
        // IPv4-mapped ::ffff:0:0/96 -> judge the embedded IPv4.
        if (allZero(b, 0, 10) && (b[10] & 0xff) == 0xff && (b[11] & 0xff) == 0xff) return embeddedV4(b, 12);
        // NAT64 64:ff9b::/96 -> judge the embedded IPv4.
        if (b0 == 0x00 && b1 == 0x64 && (b[2] & 0xff) == 0xff && (b[3] & 0xff) == 0x9b) {
            if (allZero(b, 4, 12)) return embeddedV4(b, 12);
            return false; // 64:ff9b:1::/48 is local-use NAT64, and any other 64:ff9b::/32 form is not routable
        }
        // Not global unicast (2000::/3): fc00::/7 ULA, fe80::/10, fec0::/10, ff00::/8, ...
        if ((b0 & 0xe0) != 0x20) return false;
        // 6to4 2002::/16 -> judge the embedded IPv4.
        if (b0 == 0x20 && b1 == 0x02) return embeddedV4(b, 2);
        int b2 = b[2] & 0xff;
        if (b0 == 0x20 && b1 == 0x01) {
            // 2001::/23 IETF protocol assignments: Teredo, benchmarking 2001:2::/48, ORCHID and a few
            // anycast services. No ordinary web host lives there, so the whole block is refused.
            if ((b2 & 0xfe) == 0x00) return false;
            if (b2 == 0x0d && (b[3] & 0xff) == 0xb8) return false; // documentation 2001:db8::/32
        }
        if (b0 == 0x3f && b1 == 0xff && (b2 & 0xf0) == 0x00) return false; // documentation 3fff::/20
        return true;
    }

    private static boolean embeddedV4(byte[] b, int off) {
        return isPublicV4(b[off] & 0xff, b[off + 1] & 0xff, b[off + 2] & 0xff, b[off + 3] & 0xff);
    }

    private static boolean allZero(byte[] b, int from, int to) {
        for (int i = from; i < to; i++) if (b[i] != 0) return false;
        return true;
    }

    /** True when {@code host} is a plain IPv4 dotted quad or an IPv6 literal (no DNS needed). */
    public static boolean isIpLiteral(String host) {
        return parseLiteral(host) != null;
    }

    /**
     * Parses an IP literal without ever touching DNS, or returns null when {@code host} is a name.
     * IPv6 literals may be bracketed. Only strict dotted-quad IPv4 is accepted; anything exotic
     * ("0x7f.1") is treated as a name and therefore resolved and validated like any other host.
     */
    public static InetAddress parseLiteral(String host) {
        if (host == null || host.isEmpty()) return null;
        String h = host;
        if (h.startsWith("[") && h.endsWith("]")) h = h.substring(1, h.length() - 1);
        try {
            if (h.indexOf(':') >= 0) {
                // A string containing ':' is always parsed as an IPv6 literal, never resolved.
                return InetAddress.getByName(h);
            }
        } catch (UnknownHostException e) {
            return null;
        }
        String[] parts = h.split("\\.", -1);
        if (parts.length != 4) return null;
        byte[] out = new byte[4];
        for (int i = 0; i < 4; i++) {
            String p = parts[i];
            if (p.isEmpty() || p.length() > 3) return null;
            int v = 0;
            for (int j = 0; j < p.length(); j++) {
                char ch = p.charAt(j);
                if (ch < '0' || ch > '9') return null;
                v = v * 10 + (ch - '0');
            }
            if (v > 255) return null;
            out[i] = (byte) v;
        }
        try {
            return InetAddress.getByAddress(out);
        } catch (UnknownHostException e) {
            return null;
        }
    }
}

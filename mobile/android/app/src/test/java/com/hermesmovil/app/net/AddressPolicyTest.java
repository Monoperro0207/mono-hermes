package com.hermesmovil.app.net;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertTrue;

import java.net.InetAddress;
import org.junit.Test;

public class AddressPolicyTest {
    private static final String[] PUBLIC = {
        "8.8.8.8", "1.1.1.1", "9.255.255.255", "11.0.0.1", "100.63.255.255", "100.128.0.1",
        "126.255.255.255", "128.0.0.1", "169.253.255.255", "169.255.0.1", "172.15.255.255", "172.32.0.1",
        "192.0.1.1", "192.0.3.1", "192.167.255.255", "192.169.0.1", "198.17.255.255", "198.20.0.1",
        "198.51.99.1", "198.51.101.1", "203.0.112.1", "203.0.114.1", "223.255.255.255",
        "::ffff:8.8.8.8", "64:ff9b::808:808", "2002:0808:0808::1", "2606:4700::1111", "2a00:1450:4001::1",
        "2001:4860:4860::8888", "2001:1::1", "2001:db9::1", "3fff::1",
    };

    private static final String[] PRIVATE = {
        "0.0.0.0", "0.1.2.3", "10.0.0.1", "10.255.255.255", "127.0.0.1", "127.255.255.254",
        "100.64.0.1", "100.127.255.255", "169.254.0.1", "169.254.169.254", "172.16.0.1", "172.31.255.255",
        "192.168.1.1", "192.0.0.1", "192.0.2.1", "198.18.0.1", "198.19.255.255", "198.51.100.7",
        "203.0.113.9", "224.0.0.1", "239.255.255.255", "240.0.0.1", "255.255.255.255",
        "::", "::1", "::8.8.8.8", "::10.0.0.1", "::ffff:192.168.1.1", "::ffff:127.0.0.1", "::ffff:10.0.0.1",
        "64:ff9b::a00:1", "64:ff9b::7f00:1", "64:ff9b:1::1", "64:ff9b:1:ffff::1",
        "2002:c0a8:0101::", "2002:7f00:1::1", "2002:0a00:1::1",
        "2001::1", "2001:0:4136:e378:8000:63bf:3fff:fdd2", "2001:db8::1",
        "fc00::1", "fd00::1", "fdff::1", "fe80::1", "febf::1", "fec0::1", "ff00::1", "ff02::1",
        "1::1", "4000::1", "8000::1", "e000::1",
    };

    private static InetAddress ip(String literal) throws Exception {
        return InetAddress.getByName(literal); // numeric literals never hit DNS
    }

    @Test
    public void publicAddressesAreAllowed() throws Exception {
        for (String s : PUBLIC) assertTrue(s + " should be public", AddressPolicy.isPublic(ip(s)));
    }

    @Test
    public void nonPublicAddressesAreRejected() throws Exception {
        for (String s : PRIVATE) assertFalse(s + " should be rejected", AddressPolicy.isPublic(ip(s)));
    }

    @Test
    public void rawByteForm() throws Exception {
        // 16-byte IPv4-mapped input built with getByAddress is judged by its embedded IPv4.
        byte[] mapped = new byte[16];
        mapped[10] = (byte) 0xff;
        mapped[11] = (byte) 0xff;
        mapped[12] = (byte) 192;
        mapped[13] = (byte) 168;
        mapped[14] = 1;
        mapped[15] = 1;
        assertFalse(AddressPolicy.isPublic(InetAddress.getByAddress(mapped)));
        mapped[12] = 8;
        mapped[13] = 8;
        mapped[14] = 8;
        mapped[15] = 8;
        assertTrue(AddressPolicy.isPublic(InetAddress.getByAddress(mapped)));
        assertFalse(AddressPolicy.isPublic(null));
    }

    @Test
    public void ipLiteralDetection() {
        assertTrue(AddressPolicy.isIpLiteral("8.8.8.8"));
        assertTrue(AddressPolicy.isIpLiteral("::1"));
        assertTrue(AddressPolicy.isIpLiteral("[2606:4700::1111]"));
        assertFalse(AddressPolicy.isIpLiteral("example.com"));
        assertFalse(AddressPolicy.isIpLiteral("999.1.1.1"));
        assertFalse(AddressPolicy.isIpLiteral("0x7f.1"));
        assertFalse(AddressPolicy.isIpLiteral("1.2.3"));
        assertFalse(AddressPolicy.isIpLiteral(""));
        assertNull(AddressPolicy.parseLiteral(null));
        assertEquals("127.0.0.1", AddressPolicy.parseLiteral("127.0.0.1").getHostAddress());
    }
}

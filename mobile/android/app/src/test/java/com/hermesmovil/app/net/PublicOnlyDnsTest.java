package com.hermesmovil.app.net;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertTrue;
import static org.junit.Assert.fail;

import java.net.InetAddress;
import java.net.UnknownHostException;
import java.util.Arrays;
import java.util.Collections;
import java.util.List;
import java.util.concurrent.atomic.AtomicInteger;
import org.junit.Test;

public class PublicOnlyDnsTest {
    private final AtomicInteger delegateCalls = new AtomicInteger();

    private PublicOnlyDns dnsReturning(InetAddress... answer) {
        return new PublicOnlyDns(host -> {
            delegateCalls.incrementAndGet();
            return Arrays.asList(answer);
        }, AddressPolicy::isPublic);
    }

    private static InetAddress ip(String s) throws Exception {
        return InetAddress.getByName(s);
    }

    private static void assertBlocked(PublicOnlyDns dns, String host) {
        try {
            dns.lookup(host);
            fail("expected blocked_host for " + host);
        } catch (UnknownHostException e) {
            assertTrue(e.getMessage(), e.getMessage().startsWith("blocked_host:"));
        }
    }

    @Test
    public void publicAnswerPasses() throws Exception {
        List<InetAddress> out = dnsReturning(ip("8.8.8.8")).lookup("example.com");
        assertEquals(1, out.size());
        assertEquals("8.8.8.8", out.get(0).getHostAddress());
    }

    @Test
    public void mixedAnswerIsRefused() throws Exception {
        assertBlocked(dnsReturning(ip("8.8.8.8"), ip("10.0.0.1")), "rebind.example");
    }

    @Test
    public void privateAnswerIsRefused() throws Exception {
        assertBlocked(dnsReturning(ip("100.64.0.5")), "tailnet.example");
    }

    @Test
    public void emptyAnswerIsRefused() {
        PublicOnlyDns dns = new PublicOnlyDns(host -> Collections.emptyList(), AddressPolicy::isPublic);
        assertBlocked(dns, "nothing.example");
    }

    @Test
    public void privateLiteralIsRefusedWithoutResolving() {
        assertBlocked(dnsReturning(), "127.0.0.1");
        assertBlocked(dnsReturning(), "169.254.169.254");
        assertBlocked(dnsReturning(), "::1");
        assertEquals(0, delegateCalls.get());
    }

    @Test
    public void publicLiteralPassesWithoutResolving() throws Exception {
        List<InetAddress> out = dnsReturning().lookup("1.1.1.1");
        assertEquals("1.1.1.1", out.get(0).getHostAddress());
        assertEquals(0, delegateCalls.get());
    }
}

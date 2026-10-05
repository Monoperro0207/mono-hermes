package com.hermesmovil.app.net;

import java.net.InetAddress;
import java.net.UnknownHostException;
import java.util.List;
import java.util.function.Predicate;
import okhttp3.Dns;

/**
 * DNS resolver that refuses anything that is not a public address.
 *
 * <p>This is the DNS-rebinding fix: the list returned here is the list OkHttp connects to, so the
 * address that was validated and the address that is dialled come from one single resolution (there
 * is no second lookup an attacker-controlled DNS server could answer differently). If ANY address of
 * an answer fails the policy the whole lookup is refused, so a mixed answer such as
 * [8.8.8.8, 10.0.0.1] cannot be used to reach the private one.
 */
public final class PublicOnlyDns implements Dns {
    /** Prefix of the exception message; {@link BoundedFetcher} maps it to the {@code blocked_host} code. */
    public static final String BLOCKED_PREFIX = "blocked_host:";

    private final Dns delegate;
    private final Predicate<InetAddress> policy;

    public PublicOnlyDns() {
        this(Dns.SYSTEM, AddressPolicy::isPublic);
    }

    public PublicOnlyDns(Dns delegate, Predicate<InetAddress> policy) {
        this.delegate = delegate;
        this.policy = policy;
    }

    @Override
    public List<InetAddress> lookup(String hostname) throws UnknownHostException {
        InetAddress literal = AddressPolicy.parseLiteral(hostname);
        if (literal != null) {
            if (!policy.test(literal)) throw blocked(hostname);
            return List.of(literal);
        }
        List<InetAddress> addresses = delegate.lookup(hostname);
        if (addresses == null || addresses.isEmpty()) throw blocked(hostname);
        for (InetAddress a : addresses) {
            if (!policy.test(a)) throw blocked(hostname);
        }
        return addresses;
    }

    private static UnknownHostException blocked(String host) {
        return new UnknownHostException(BLOCKED_PREFIX + " " + host);
    }
}

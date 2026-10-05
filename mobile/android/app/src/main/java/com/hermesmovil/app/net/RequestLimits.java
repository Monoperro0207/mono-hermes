package com.hermesmovil.app.net;

/**
 * Hard ceilings the native layer enforces on every request, whatever the JavaScript caller asks
 * for. The JS constants (LINK_TITLE_MAX_BYTES, MAX_MEDIA_BYTES, MAX_IMAGE_SAVE_BYTES, MAX_SAVE_BYTES
 * in src/bridge/) may only ask for these values or less: anything above, non-finite or
 * non-positive is refused, never clamped. Pure Java so it runs on the JVM in unit tests.
 */
public final class RequestLimits {
    private RequestLimits() {}

    public static final int TEXT_MAX_BYTES = 64 * 1024;
    public static final int TEXT_MAX_REDIRECTS = 3;
    public static final long MEDIA_MAX_BYTES = 64L * 1024 * 1024;
    public static final long PUBLIC_DOWNLOAD_MAX_BYTES = 32L * 1024 * 1024;
    public static final long GATEWAY_DOWNLOAD_MAX_BYTES = 1024L * 1024 * 1024;

    public static boolean validText(Integer maxBytes, Integer maxRedirects) {
        if (maxBytes == null || maxBytes <= 0 || maxBytes > TEXT_MAX_BYTES) return false;
        return maxRedirects != null && maxRedirects >= 0 && maxRedirects <= TEXT_MAX_REDIRECTS;
    }

    /**
     * Ceiling for one download route, or -1 for an unknown directory. A public-web download is
     * capped at {@link #PUBLIC_DOWNLOAD_MAX_BYTES} whatever directory it lands in.
     */
    public static long downloadCeiling(String directory, boolean publicOnly) {
        long ceiling;
        if ("media".equals(directory)) {
            ceiling = MEDIA_MAX_BYTES;
        } else if ("downloads".equals(directory)) {
            ceiling = GATEWAY_DOWNLOAD_MAX_BYTES;
        } else {
            return -1;
        }
        return publicOnly ? Math.min(ceiling, PUBLIC_DOWNLOAD_MAX_BYTES) : ceiling;
    }

    /** True when {@code maxBytes} is a finite whole number in {@code [1, ceiling]} for the route. */
    public static boolean validDownload(Double maxBytes, String directory, boolean publicOnly) {
        long ceiling = downloadCeiling(directory, publicOnly);
        if (ceiling <= 0 || maxBytes == null || maxBytes.isNaN() || maxBytes.isInfinite()) return false;
        double v = maxBytes;
        return v >= 1 && v <= ceiling && v == Math.floor(v);
    }
}

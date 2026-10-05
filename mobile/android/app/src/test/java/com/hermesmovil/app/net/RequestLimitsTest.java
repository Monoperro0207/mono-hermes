package com.hermesmovil.app.net;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

import org.junit.Test;

public class RequestLimitsTest {
    private static final double MIB = 1024 * 1024;

    @Test
    public void textAcceptsOnlyTheLinkTitleBudget() {
        assertTrue(RequestLimits.validText(64 * 1024, 3));
        assertTrue(RequestLimits.validText(1, 0));
        assertFalse(RequestLimits.validText(64 * 1024 + 1, 3));
        assertFalse(RequestLimits.validText(0, 3));
        assertFalse(RequestLimits.validText(-1, 3));
        assertFalse(RequestLimits.validText(null, 3));
        assertFalse(RequestLimits.validText(1024, 4));
        assertFalse(RequestLimits.validText(1024, -1));
        assertFalse(RequestLimits.validText(1024, Integer.MAX_VALUE));
        assertFalse(RequestLimits.validText(1024, null));
    }

    @Test
    public void ceilingsPerRoute() {
        assertEquals(64L * 1024 * 1024, RequestLimits.downloadCeiling("media", false));
        assertEquals(1024L * 1024 * 1024, RequestLimits.downloadCeiling("downloads", false));
        assertEquals(32L * 1024 * 1024, RequestLimits.downloadCeiling("downloads", true));
        assertEquals(32L * 1024 * 1024, RequestLimits.downloadCeiling("media", true));
        assertEquals(-1, RequestLimits.downloadCeiling("../etc", false));
        assertEquals(-1, RequestLimits.downloadCeiling(null, true));
    }

    @Test
    public void downloadsAtTheCeilingPassAndAboveAreRefused() {
        assertTrue(RequestLimits.validDownload(64 * MIB, "media", false));
        assertFalse(RequestLimits.validDownload(64 * MIB + 1, "media", false));
        assertTrue(RequestLimits.validDownload(1024 * MIB, "downloads", false));
        assertFalse(RequestLimits.validDownload(1024 * MIB + 1, "downloads", false));
        assertTrue(RequestLimits.validDownload(32 * MIB, "downloads", true));
        assertFalse(RequestLimits.validDownload(33 * MIB, "downloads", true));
        assertTrue(RequestLimits.validDownload(1.0, "media", false));
    }

    @Test
    public void absurdSizesAreRefusedNotClamped() {
        assertFalse(RequestLimits.validDownload(null, "downloads", false));
        assertFalse(RequestLimits.validDownload(0.0, "downloads", false));
        assertFalse(RequestLimits.validDownload(-5.0, "downloads", false));
        assertFalse(RequestLimits.validDownload(0.5, "downloads", false));
        assertFalse(RequestLimits.validDownload(1024.5, "downloads", false));
        assertFalse(RequestLimits.validDownload(Double.NaN, "downloads", false));
        assertFalse(RequestLimits.validDownload(Double.POSITIVE_INFINITY, "downloads", false));
        assertFalse(RequestLimits.validDownload(9.3e18, "downloads", false));
        assertFalse(RequestLimits.validDownload(1024.0, "other", false));
    }
}

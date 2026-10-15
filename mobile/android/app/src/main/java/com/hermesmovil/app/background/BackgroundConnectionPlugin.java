package com.hermesmovil.app.background;

import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

/**
 * JS side of {@link ConnectionService}: the bridge reports whether a turn is in flight. Starting and
 * stopping the service follows the activity lifecycle (MainActivity), not JavaScript, because the
 * service has to be started while the app is still allowed to start one: on the way out.
 */
@CapacitorPlugin(name = "BackgroundConnection")
public class BackgroundConnectionPlugin extends Plugin {
    @PluginMethod
    public void setWorking(PluginCall call) {
        ConnectionService.setWorking(Boolean.TRUE.equals(call.getBoolean("working", false)));
        call.resolve();
    }

    /** Hardware back minimises the app from JS; start the service before the activity stops. */
    @PluginMethod
    public void hold(PluginCall call) {
        ConnectionService.start(getContext());
        call.resolve();
    }
}

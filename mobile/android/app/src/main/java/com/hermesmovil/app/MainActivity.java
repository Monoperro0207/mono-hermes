package com.hermesmovil.app;

import android.os.Bundle;
import com.getcapacitor.BridgeActivity;
import com.hermesmovil.app.background.BackgroundConnectionPlugin;
import com.hermesmovil.app.background.ConnectionService;
import com.hermesmovil.app.guest.GuestBrowserPlugin;
import com.hermesmovil.app.net.BoundedHttpPlugin;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        // Local plugins must be registered before super.onCreate() builds the bridge.
        registerPlugin(BoundedHttpPlugin.class);
        registerPlugin(GuestBrowserPlugin.class);
        registerPlugin(BackgroundConnectionPlugin.class);
        super.onCreate(savedInstanceState);
    }

    @Override
    public void onStart() {
        super.onStart();
        // Visible again: the app has the network on its own, the service and its notification go.
        ConnectionService.stop(this);
    }

    /** Home / recents: the activity is still on top, the last moment a service start is always allowed. */
    @Override
    protected void onUserLeaveHint() {
        super.onUserLeaveHint();
        ConnectionService.start(this);
    }

    /** Every other way out (another app on top, the file picker, back): still inside the start grace. */
    @Override
    public void onStop() {
        super.onStop();
        if (!isChangingConfigurations() && !isFinishing()) {
            ConnectionService.start(this);
        }
    }
}

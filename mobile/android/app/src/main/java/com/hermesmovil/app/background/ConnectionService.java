package com.hermesmovil.app.background;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.content.pm.ServiceInfo;
import android.os.Build;
import android.os.Handler;
import android.os.IBinder;
import android.os.Looper;
import android.util.Log;
import androidx.core.app.NotificationCompat;
import androidx.core.app.ServiceCompat;
import androidx.core.content.ContextCompat;
import com.hermesmovil.app.MainActivity;
import com.hermesmovil.app.R;

/**
 * Keeps the app's network while it is in the background.
 *
 * Android 15+ cuts the network of a backgrounded app after a few seconds (the APP_BACKGROUND
 * firewall chain), which kills the gateway WebSocket every time the user switches apps: the reply
 * stops streaming, the "turn finished" notification never comes, and coming back means a full
 * reconnect. A foreground service exempts the process. It runs only while the app is not visible:
 * for as long as a turn is in flight, then for {@link #GRACE_MS} after the last one ends (or after
 * leaving, when nothing is running). After that it stops and Android may cut the network again.
 */
public class ConnectionService extends Service {
    private static final String TAG = "HermesConnection";
    private static final String CHANNEL_ID = "connection";
    private static final int NOTIFICATION_ID = 7101;
    static final long GRACE_MS = 5 * 60_000L;

    private static volatile boolean working;
    private static volatile ConnectionService instance;

    private final Handler handler = new Handler(Looper.getMainLooper());
    private final Runnable graceExpired = this::stopSelf;
    private Boolean shownWorking;

    /** Start (or refresh) the service. Safe to call repeatedly; never throws. */
    public static void start(Context context) {
        try {
            ContextCompat.startForegroundService(context, new Intent(context, ConnectionService.class));
        } catch (RuntimeException e) {
            // ForegroundServiceStartNotAllowedException (API 31+) and friends: the app left the
            // foreground too long ago. The connection then simply drops, as it did before.
            Log.w(TAG, "could not start the connection service: " + e);
        }
    }

    public static void stop(Context context) {
        context.stopService(new Intent(context, ConnectionService.class));
    }

    /** Whether a turn is in flight; while true the grace countdown is suspended. */
    public static void setWorking(boolean value) {
        working = value;
        ConnectionService service = instance;
        if (service != null) service.handler.post(service::refresh);
    }

    @Override
    public void onCreate() {
        super.onCreate();
        instance = this;
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        try {
            int type = Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q ? ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC : 0;
            ServiceCompat.startForeground(this, NOTIFICATION_ID, buildNotification(working), type);
            shownWorking = working;
        } catch (RuntimeException e) {
            Log.w(TAG, "startForeground refused: " + e);
            stopSelf();
            return START_NOT_STICKY;
        }
        // A fresh start (the user just left the app) restarts the grace window.
        handler.removeCallbacks(graceExpired);
        if (!working) handler.postDelayed(graceExpired, GRACE_MS);
        return START_NOT_STICKY;
    }

    private void refresh() {
        if (shownWorking == null) return;
        if (shownWorking != working) {
            shownWorking = working;
            NotificationManager manager = getSystemService(NotificationManager.class);
            if (manager != null) manager.notify(NOTIFICATION_ID, buildNotification(working));
            handler.removeCallbacks(graceExpired);
            // The window counts from the end of the last turn, so its result can still be read live.
            if (!working) handler.postDelayed(graceExpired, GRACE_MS);
        }
    }

    private Notification buildNotification(boolean isWorking) {
        NotificationManager manager = getSystemService(NotificationManager.class);
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O && manager != null) {
            NotificationChannel channel = new NotificationChannel(CHANNEL_ID, "Connection to your server", NotificationManager.IMPORTANCE_LOW);
            channel.setDescription("Shown while Mono Hermes keeps its connection open in the background.");
            channel.setShowBadge(false);
            manager.createNotificationChannel(channel);
        }

        Intent open = new Intent(this, MainActivity.class).addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP);
        PendingIntent tap = PendingIntent.getActivity(this, 0, open, PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT);

        return new NotificationCompat.Builder(this, CHANNEL_ID)
            .setSmallIcon(R.drawable.ic_stat_hermes)
            .setContentTitle(isWorking ? "Hermes is working" : "Connected to your Hermes server")
            .setContentText(isWorking ? "The reply keeps arriving while you are in another app." : "Kept open for a few minutes so you can come right back.")
            .setContentIntent(tap)
            .setOngoing(true)
            .setSilent(true)
            .setShowWhen(false)
            .setCategory(NotificationCompat.CATEGORY_SERVICE)
            .setPriority(NotificationCompat.PRIORITY_LOW)
            .build();
    }

    /** Android 15 caps dataSync services at 6 h a day; when the system says time is up, stop. */
    @Override
    public void onTimeout(int startId, int fgsType) {
        stopSelf();
    }

    @Override
    public void onDestroy() {
        handler.removeCallbacksAndMessages(null);
        instance = null;
        super.onDestroy();
    }

    @Override
    public IBinder onBind(Intent intent) {
        return null;
    }
}

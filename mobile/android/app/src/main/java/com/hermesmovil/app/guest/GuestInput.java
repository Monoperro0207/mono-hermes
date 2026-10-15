package com.hermesmovil.app.guest;

import android.os.SystemClock;
import android.view.InputDevice;
import android.view.KeyCharacterMap;
import android.view.KeyEvent;
import android.view.MotionEvent;
import android.view.ViewConfiguration;
import android.webkit.WebView;
import org.json.JSONArray;
import org.json.JSONObject;

/**
 * Turns the preview pane's Electron-style input events (preview-input.ts: mouseDown / mouseUp /
 * mouseMove / mouseWheel / keyDown / keyUp / char) into real MotionEvents and KeyEvents dispatched
 * to one guest WebView, so hover, trusted clicks and typing behave as they would for a hand.
 *
 * Coordinates arrive in the guest's CSS pixels and are scaled by the WebView's own page scale
 * (density x viewport zoom), which is what maps CSS px to view px. UI thread only.
 */
final class GuestInput {
    private final WebView view;
    private long downTime;
    private boolean buttonDown;

    GuestInput(WebView view) {
        this.view = view;
    }

    void dispatch(JSONObject e) {
        switch (e.optString("type")) {
            case "mouseDown":
            case "mouseUp":
            case "mouseMove":
            case "mouseWheel":
                mouse(e);
                break;
            case "keyDown":
            case "keyUp":
            case "char":
                key(e);
                break;
            default:
                break;
        }
    }

    // --- pointer ---------------------------------------------------------------------------------

    @SuppressWarnings("deprecation")
    private float scale() {
        float s = view.getScale();
        return s > 0 ? s : view.getResources().getDisplayMetrics().density;
    }

    private void mouse(JSONObject e) {
        float s = scale();
        float x = (float) e.optDouble("x", 0) * s;
        float y = (float) e.optDouble("y", 0) * s;
        long now = SystemClock.uptimeMillis();
        switch (e.optString("type")) {
            case "mouseDown":
                view.requestFocus();
                buttonDown = true;
                downTime = now;
                touch(MotionEvent.ACTION_DOWN, x, y, now);
                break;
            case "mouseUp":
                touch(MotionEvent.ACTION_UP, x, y, now);
                buttonDown = false;
                break;
            case "mouseMove":
                if (buttonDown) touch(MotionEvent.ACTION_MOVE, x, y, now);
                else generic(MotionEvent.ACTION_HOVER_MOVE, x, y, 0, 0, now);
                break;
            default:
                wheel(e, x, y, now);
                break;
        }
    }

    /** Electron deltas are in px (positive = content moves down); AXIS_*SCROLL counts wheel ticks. */
    private void wheel(JSONObject e, float x, float y, long now) {
        float factor = 64f;
        if (android.os.Build.VERSION.SDK_INT >= 26) {
            factor = ViewConfiguration.get(view.getContext()).getScaledVerticalScrollFactor();
        }
        float s = scale();
        float v = (float) e.optDouble("deltaY", 0) * s / factor;
        float h = (float) -e.optDouble("deltaX", 0) * s / factor;
        generic(MotionEvent.ACTION_SCROLL, x, y, v, h, now);
    }

    private MotionEvent mouseEvent(int action, float x, float y, long now, float vscroll, float hscroll) {
        MotionEvent.PointerProperties[] props = {new MotionEvent.PointerProperties()};
        props[0].id = 0;
        props[0].toolType = MotionEvent.TOOL_TYPE_MOUSE;
        MotionEvent.PointerCoords[] coords = {new MotionEvent.PointerCoords()};
        coords[0].x = x;
        coords[0].y = y;
        coords[0].pressure = action == MotionEvent.ACTION_UP ? 0f : 1f;
        coords[0].size = 1f;
        if (action == MotionEvent.ACTION_SCROLL) {
            coords[0].setAxisValue(MotionEvent.AXIS_VSCROLL, vscroll);
            coords[0].setAxisValue(MotionEvent.AXIS_HSCROLL, hscroll);
        }
        boolean pressed = action == MotionEvent.ACTION_DOWN || action == MotionEvent.ACTION_MOVE;
        int buttons = pressed ? MotionEvent.BUTTON_PRIMARY : 0;
        return MotionEvent.obtain(downTime == 0 ? now : downTime, now, action, 1, props, coords, 0, buttons, 1f, 1f, 0, 0,
            InputDevice.SOURCE_MOUSE, 0);
    }

    private void touch(int action, float x, float y, long now) {
        MotionEvent ev = mouseEvent(action, x, y, now, 0, 0);
        view.dispatchTouchEvent(ev);
        ev.recycle();
    }

    private void generic(int action, float x, float y, float vscroll, float hscroll, long now) {
        MotionEvent ev = mouseEvent(action, x, y, now, vscroll, hscroll);
        view.dispatchGenericMotionEvent(ev);
        ev.recycle();
    }

    // --- keyboard --------------------------------------------------------------------------------

    private void key(JSONObject e) {
        String type = e.optString("type");
        String name = e.optString("keyCode");
        int meta = metaState(e.optJSONArray("modifiers"));
        int code = namedKey(name);
        if (code == KeyEvent.KEYCODE_UNKNOWN && name.length() == 1) {
            // A printable character: find the physical key (and Shift state) that types it.
            KeyEvent[] events = KeyCharacterMap.load(KeyCharacterMap.VIRTUAL_KEYBOARD).getEvents(new char[] {name.charAt(0)});
            if (events != null) {
                for (KeyEvent ev : events) {
                    if (ev.getAction() == KeyEvent.ACTION_DOWN && !isModifier(ev.getKeyCode())) {
                        code = ev.getKeyCode();
                        meta |= ev.getMetaState();
                        break;
                    }
                }
            }
            if (code == KeyEvent.KEYCODE_UNKNOWN) {
                // No key types it: a `char` phase inserts the text directly, keyDown/keyUp are no-ops.
                if (type.equals("char")) {
                    view.dispatchKeyEvent(new KeyEvent(SystemClock.uptimeMillis(), name, KeyCharacterMap.VIRTUAL_KEYBOARD, 0));
                }
                return;
            }
        }
        // Android types the character on key-down, so Electron's separate `char` phase must not repeat it.
        if (code == KeyEvent.KEYCODE_UNKNOWN || type.equals("char")) return;
        long now = SystemClock.uptimeMillis();
        int action = type.equals("keyDown") ? KeyEvent.ACTION_DOWN : KeyEvent.ACTION_UP;
        view.dispatchKeyEvent(new KeyEvent(now, now, action, code, 0, meta, KeyCharacterMap.VIRTUAL_KEYBOARD, 0));
    }

    private static boolean isModifier(int code) {
        return code == KeyEvent.KEYCODE_SHIFT_LEFT || code == KeyEvent.KEYCODE_SHIFT_RIGHT || code == KeyEvent.KEYCODE_ALT_LEFT
            || code == KeyEvent.KEYCODE_ALT_RIGHT || code == KeyEvent.KEYCODE_CTRL_LEFT || code == KeyEvent.KEYCODE_CTRL_RIGHT
            || code == KeyEvent.KEYCODE_META_LEFT || code == KeyEvent.KEYCODE_META_RIGHT;
    }

    private static int metaState(JSONArray modifiers) {
        int meta = 0;
        if (modifiers == null) return meta;
        for (int i = 0; i < modifiers.length(); i++) {
            switch (modifiers.optString(i).toLowerCase(java.util.Locale.ROOT)) {
                case "shift":
                    meta |= KeyEvent.META_SHIFT_ON | KeyEvent.META_SHIFT_LEFT_ON;
                    break;
                case "control":
                case "ctrl":
                    meta |= KeyEvent.META_CTRL_ON | KeyEvent.META_CTRL_LEFT_ON;
                    break;
                case "alt":
                    meta |= KeyEvent.META_ALT_ON | KeyEvent.META_ALT_LEFT_ON;
                    break;
                case "meta":
                case "cmd":
                case "command":
                    meta |= KeyEvent.META_META_ON | KeyEvent.META_META_LEFT_ON;
                    break;
                default:
                    break;
            }
        }
        return meta;
    }

    /** Electron key names (the ones preview-act / preview-drive send) -> Android key codes. */
    private static int namedKey(String name) {
        switch (name.toLowerCase(java.util.Locale.ROOT)) {
            case "enter":
            case "return":
                return KeyEvent.KEYCODE_ENTER;
            case "tab":
                return KeyEvent.KEYCODE_TAB;
            case "backspace":
                return KeyEvent.KEYCODE_DEL;
            case "delete":
                return KeyEvent.KEYCODE_FORWARD_DEL;
            case "escape":
            case "esc":
                return KeyEvent.KEYCODE_ESCAPE;
            case "space":
            case " ":
                return KeyEvent.KEYCODE_SPACE;
            case "arrowup":
            case "up":
                return KeyEvent.KEYCODE_DPAD_UP;
            case "arrowdown":
            case "down":
                return KeyEvent.KEYCODE_DPAD_DOWN;
            case "arrowleft":
            case "left":
                return KeyEvent.KEYCODE_DPAD_LEFT;
            case "arrowright":
            case "right":
                return KeyEvent.KEYCODE_DPAD_RIGHT;
            case "home":
                return KeyEvent.KEYCODE_MOVE_HOME;
            case "end":
                return KeyEvent.KEYCODE_MOVE_END;
            case "pageup":
                return KeyEvent.KEYCODE_PAGE_UP;
            case "pagedown":
                return KeyEvent.KEYCODE_PAGE_DOWN;
            case "insert":
                return KeyEvent.KEYCODE_INSERT;
            default:
                return KeyEvent.KEYCODE_UNKNOWN;
        }
    }
}

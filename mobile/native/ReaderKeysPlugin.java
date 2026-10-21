package com.change7488.yomireader;

import android.view.KeyEvent;
import android.view.View;
import android.view.Window;
import android.view.WindowInsets;
import android.view.WindowInsetsController;
import android.os.Build;
import android.graphics.Color;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

@CapacitorPlugin(name = "ReaderKeys")
public class ReaderKeysPlugin extends Plugin {
    private boolean enabled = false;

    @PluginMethod
    public void setEnabled(PluginCall call) {
        enabled = Boolean.TRUE.equals(call.getBoolean("enabled", false));
        call.resolve();
    }

    @PluginMethod
    public void setImmersive(PluginCall call) {
        final boolean immersive = Boolean.TRUE.equals(call.getBoolean("enabled", false));
        getActivity().runOnUiThread(() -> {
            final Window window = getActivity().getWindow();
            final View decor = window.getDecorView();
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
                window.setDecorFitsSystemWindows(!immersive);
                WindowInsetsController controller = window.getInsetsController();
                if (controller != null) {
                    int bars = WindowInsets.Type.statusBars() | WindowInsets.Type.navigationBars();
                    if (immersive) {
                        controller.setSystemBarsBehavior(WindowInsetsController.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE);
                        controller.hide(bars);
                    } else {
                        controller.show(bars);
                        controller.setSystemBarsAppearance(
                            WindowInsetsController.APPEARANCE_LIGHT_STATUS_BARS | WindowInsetsController.APPEARANCE_LIGHT_NAVIGATION_BARS,
                            WindowInsetsController.APPEARANCE_LIGHT_STATUS_BARS | WindowInsetsController.APPEARANCE_LIGHT_NAVIGATION_BARS
                        );
                    }
                }
            } else {
                int flags = immersive
                    ? View.SYSTEM_UI_FLAG_FULLSCREEN | View.SYSTEM_UI_FLAG_HIDE_NAVIGATION |
                      View.SYSTEM_UI_FLAG_IMMERSIVE_STICKY | View.SYSTEM_UI_FLAG_LAYOUT_FULLSCREEN |
                      View.SYSTEM_UI_FLAG_LAYOUT_HIDE_NAVIGATION | View.SYSTEM_UI_FLAG_LAYOUT_STABLE
                    : View.SYSTEM_UI_FLAG_LIGHT_STATUS_BAR |
                      (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O ? View.SYSTEM_UI_FLAG_LIGHT_NAVIGATION_BAR : 0);
                decor.setSystemUiVisibility(flags);
            }
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
                android.view.WindowManager.LayoutParams attrs = window.getAttributes();
                attrs.layoutInDisplayCutoutMode = immersive
                    ? android.view.WindowManager.LayoutParams.LAYOUT_IN_DISPLAY_CUTOUT_MODE_SHORT_EDGES
                    : android.view.WindowManager.LayoutParams.LAYOUT_IN_DISPLAY_CUTOUT_MODE_DEFAULT;
                window.setAttributes(attrs);
            }
            // When back on the shelf, use the app's paper background instead of a black band.
            window.setStatusBarColor(immersive ? Color.TRANSPARENT : Color.rgb(247, 246, 242));
            window.setNavigationBarColor(immersive ? Color.TRANSPARENT : Color.rgb(247, 246, 242));
            call.resolve();
        });
    }

    public boolean handleKeyDown(int keyCode, int repeatCount) {
        if (!enabled || (keyCode != KeyEvent.KEYCODE_VOLUME_UP && keyCode != KeyEvent.KEYCODE_VOLUME_DOWN)) return false;
        if (repeatCount == 0) {
            JSObject payload = new JSObject();
            payload.put("direction", keyCode == KeyEvent.KEYCODE_VOLUME_DOWN ? 1 : -1);
            notifyListeners("pageTurn", payload);
        }
        return true;
    }

    public boolean handleKeyUp(int keyCode) {
        return enabled && (keyCode == KeyEvent.KEYCODE_VOLUME_UP || keyCode == KeyEvent.KEYCODE_VOLUME_DOWN);
    }

    @Override
    protected void handleOnDestroy() {
        enabled = false;
    }
}

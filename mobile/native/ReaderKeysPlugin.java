package com.change7488.yomireader;

import android.view.KeyEvent;
import android.view.View;
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
        final boolean enabled = Boolean.TRUE.equals(call.getBoolean("enabled", false));
        getActivity().runOnUiThread(() -> {
            View decor = getActivity().getWindow().getDecorView();
            int flags = enabled ? (View.SYSTEM_UI_FLAG_FULLSCREEN | View.SYSTEM_UI_FLAG_HIDE_NAVIGATION | View.SYSTEM_UI_FLAG_IMMERSIVE_STICKY | View.SYSTEM_UI_FLAG_LAYOUT_FULLSCREEN | View.SYSTEM_UI_FLAG_LAYOUT_HIDE_NAVIGATION | View.SYSTEM_UI_FLAG_LAYOUT_STABLE) : View.SYSTEM_UI_FLAG_VISIBLE;
            decor.setSystemUiVisibility(flags);
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

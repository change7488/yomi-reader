package com.change7488.yomireader;

import android.view.KeyEvent;
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

package com.change7488.yomireader;

import android.os.Bundle;
import android.view.KeyEvent;
import com.getcapacitor.BridgeActivity;
import com.getcapacitor.PluginHandle;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        registerPlugin(ReaderKeysPlugin.class);
        super.onCreate(savedInstanceState);
    }

    private ReaderKeysPlugin readerKeys() {
        if (getBridge() == null) return null;
        PluginHandle handle = getBridge().getPlugin("ReaderKeys");
        return handle == null ? null : (ReaderKeysPlugin) handle.getInstance();
    }

    @Override
    public boolean onKeyDown(int keyCode, KeyEvent event) {
        ReaderKeysPlugin plugin = readerKeys();
        if (plugin != null && plugin.handleKeyDown(keyCode, event.getRepeatCount())) return true;
        return super.onKeyDown(keyCode, event);
    }

    @Override
    public boolean onKeyUp(int keyCode, KeyEvent event) {
        ReaderKeysPlugin plugin = readerKeys();
        if (plugin != null && plugin.handleKeyUp(keyCode)) return true;
        return super.onKeyUp(keyCode, event);
    }
}

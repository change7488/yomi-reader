package com.change7488.yomireader;

import android.app.Activity;
import android.content.ClipData;
import android.content.Intent;
import android.database.Cursor;
import android.net.Uri;
import android.provider.DocumentsContract;
import android.util.Base64;

import androidx.activity.result.ActivityResult;

import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.ActivityCallback;
import com.getcapacitor.annotation.CapacitorPlugin;

import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.HashSet;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Set;
import java.util.UUID;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

@CapacitorPlugin(name = "ReaderFiles")
public class ReaderFilesPlugin extends Plugin {
    // Content URI access is scoped to explicit user selections. No broad storage permission.
    private static final int MAX_RESULTS = 10000;
    private static final int MAX_DEPTH = 24;
    private static final long MAX_FILE_BYTES = 128L * 1024L * 1024L;
    private final ExecutorService io = Executors.newSingleThreadExecutor();
    private final Map<String, Uri> allowedFiles = new HashMap<>();
    private Uri selectedTree;

    @PluginMethod
    public void chooseFolder(PluginCall call) {
        Intent intent = new Intent(Intent.ACTION_OPEN_DOCUMENT_TREE);
        intent.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION | Intent.FLAG_GRANT_PERSISTABLE_URI_PERMISSION);
        startActivityForResult(call, intent, "onFolderChosen");
    }

    @ActivityCallback
    private void onFolderChosen(PluginCall call, ActivityResult result) {
        Intent data = result.getData();
        if (result.getResultCode() != Activity.RESULT_OK || data == null || data.getData() == null) {
            JSObject reply = new JSObject();
            reply.put("cancelled", true);
            call.resolve(reply);
            return;
        }
        selectedTree = data.getData();
        synchronized (allowedFiles) { allowedFiles.clear(); }
        try {
            getContext().getContentResolver().takePersistableUriPermission(selectedTree, Intent.FLAG_GRANT_READ_URI_PERMISSION);
        } catch (SecurityException ignored) {
            // Some providers grant only session access.
        }
        JSObject reply = new JSObject();
        reply.put("cancelled", false);
        reply.put("name", folderDisplayName(selectedTree));
        call.resolve(reply);
    }

    @PluginMethod
    public void scanFolder(PluginCall call) {
        final Uri tree = selectedTree;
        if (tree == null) { call.reject("请先选择一个文件夹"); return; }
        final Set<String> formats = new HashSet<>();
        for (String value : call.getString("extensions", "epub,pdf,txt").split(",")) {
            String ext = value.trim().toLowerCase(Locale.ROOT);
            if (ext.equals("epub") || ext.equals("pdf") || ext.equals("txt")) formats.add(ext);
        }
        final int minimum = Math.max(0, call.getInt("minBytes", 0));
        io.execute(() -> {
            try {
                JSArray items = new JSArray();
                synchronized (allowedFiles) { allowedFiles.clear(); }
                scanChildren(tree, DocumentsContract.getTreeDocumentId(tree), "", 0, formats, minimum, items);
                JSObject reply = new JSObject();
                reply.put("files", items);
                reply.put("limited", items.length() >= MAX_RESULTS);
                call.resolve(reply);
            } catch (Exception error) {
                call.reject("读取文件夹失败：" + error.getMessage());
            }
        });
    }

    private void scanChildren(Uri tree, String parentId, String prefix, int depth,
                              Set<String> formats, int minimum, JSArray items) throws Exception {
        if (depth >= MAX_DEPTH || items.length() >= MAX_RESULTS) return;
        Uri children = DocumentsContract.buildChildDocumentsUriUsingTree(tree, parentId);
        String[] columns = {
            DocumentsContract.Document.COLUMN_DOCUMENT_ID,
            DocumentsContract.Document.COLUMN_DISPLAY_NAME,
            DocumentsContract.Document.COLUMN_MIME_TYPE,
            DocumentsContract.Document.COLUMN_SIZE
        };
        try (Cursor cursor = getContext().getContentResolver().query(children, columns, null, null, null)) {
            if (cursor == null) return;
            while (cursor.moveToNext() && items.length() < MAX_RESULTS) {
                String id = cursor.getString(0);
                String name = cursor.getString(1);
                String mime = cursor.getString(2);
                long size = cursor.isNull(3) ? -1 : cursor.getLong(3);
                if (id == null || name == null || name.startsWith(".")) continue;
                String relative = prefix.isEmpty() ? name : prefix + "/" + name;
                if (DocumentsContract.Document.MIME_TYPE_DIR.equals(mime)) {
                    scanChildren(tree, id, relative, depth + 1, formats, minimum, items);
                    continue;
                }
                int dot = name.lastIndexOf('.');
                String ext = dot < 0 ? "" : name.substring(dot + 1).toLowerCase(Locale.ROOT);
                if (!formats.contains(ext) || size == 0 || size > MAX_FILE_BYTES || (size >= 0 && size < minimum)) continue;
                String key = UUID.randomUUID().toString();
                synchronized (allowedFiles) {
                    allowedFiles.put(key, DocumentsContract.buildDocumentUriUsingTree(tree, id));
                }
                JSObject item = new JSObject();
                item.put("key", key);
                item.put("name", name);
                item.put("ext", ext);
                item.put("size", Math.max(0, size));
                item.put("relativePath", relative);
                items.put(item);
            }
        }
    }

    @PluginMethod
    public void chooseFiles(PluginCall call) {
        Intent intent = new Intent(Intent.ACTION_OPEN_DOCUMENT);
        intent.setType("*/*");
        intent.addCategory(Intent.CATEGORY_OPENABLE);
        intent.putExtra(Intent.EXTRA_ALLOW_MULTIPLE, true);
        intent.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION | Intent.FLAG_GRANT_PERSISTABLE_URI_PERMISSION);
        startActivityForResult(call, intent, "onFilesChosen");
    }

    @ActivityCallback
    private void onFilesChosen(PluginCall call, ActivityResult result) {
        Intent data = result.getData();
        if (result.getResultCode() != Activity.RESULT_OK || data == null) {
            JSObject reply = new JSObject();
            reply.put("cancelled", true);
            call.resolve(reply);
            return;
        }
        List<Uri> uris = new ArrayList<>();
        ClipData clip = data.getClipData();
        if (clip != null) {
            for (int i = 0; i < clip.getItemCount() && i < MAX_RESULTS; i++) {
                Uri uri = clip.getItemAt(i).getUri();
                if (uri != null) uris.add(uri);
            }
        } else if (data.getData() != null) uris.add(data.getData());
        synchronized (allowedFiles) { allowedFiles.clear(); }
        JSArray files = new JSArray();
        for (Uri uri : uris) {
            try {
                JSObject meta = describeFile(uri);
                if (meta == null) continue;
                String key = UUID.randomUUID().toString();
                synchronized (allowedFiles) { allowedFiles.put(key, uri); }
                meta.put("key", key);
                files.put(meta);
            } catch (Exception ignored) { /* Skip unreadable provider entries. */ }
        }
        JSObject reply = new JSObject();
        reply.put("cancelled", false);
        reply.put("files", files);
        call.resolve(reply);
    }

    private JSObject describeFile(Uri uri) {
        String[] columns = { DocumentsContract.Document.COLUMN_DISPLAY_NAME, DocumentsContract.Document.COLUMN_SIZE };
        try (Cursor c = getContext().getContentResolver().query(uri, columns, null, null, null)) {
            if (c == null || !c.moveToFirst()) return null;
            String name = c.getString(0);
            if (name == null) return null;
            int dot = name.lastIndexOf('.');
            String ext = dot < 0 ? "" : name.substring(dot + 1).toLowerCase(Locale.ROOT);
            if (!ext.equals("epub") && !ext.equals("pdf") && !ext.equals("txt")) return null;
            long size = c.isNull(1) ? 0L : c.getLong(1);
            JSObject item = new JSObject();
            item.put("name", name);
            item.put("ext", ext);
            item.put("size", Math.max(0, size));
            item.put("relativePath", name);
            return item;
        }
    }

    private String folderDisplayName(Uri tree) {
        try {
            Uri root = DocumentsContract.buildDocumentUriUsingTree(tree, DocumentsContract.getTreeDocumentId(tree));
            String[] columns = { DocumentsContract.Document.COLUMN_DISPLAY_NAME };
            try (Cursor c = getContext().getContentResolver().query(root, columns, null, null, null)) {
                if (c != null && c.moveToFirst() && !c.isNull(0)) return c.getString(0);
            }
        } catch (Exception ignored) { }
        return "已授权文件夹";
    }

    @PluginMethod
    public void readFile(PluginCall call) {
        String key = call.getString("key", "");
        final Uri uri;
        synchronized (allowedFiles) { uri = allowedFiles.get(key); }
        if (uri == null) { call.reject("文件授权已失效，请重新选择文件夹"); return; }
        io.execute(() -> {
            try (InputStream source = getContext().getContentResolver().openInputStream(uri)) {
                if (source == null) throw new Exception("无法打开文件流");
                ByteArrayOutputStream dest = new ByteArrayOutputStream();
                byte[] buffer = new byte[64 * 1024];
                int count;
                long total = 0;
                while ((count = source.read(buffer)) != -1) {
                    total += count;
                    if (total > MAX_FILE_BYTES) throw new Exception("单个文件暂不支持超过 128 MB");
                    dest.write(buffer, 0, count);
                }
                JSObject reply = new JSObject();
                reply.put("base64", Base64.encodeToString(dest.toByteArray(), Base64.NO_WRAP));
                call.resolve(reply);
            } catch (Exception error) {
                call.reject("读取书籍失败：" + error.getMessage());
            }
        });
    }

    @Override
    protected void handleOnDestroy() {
        io.shutdownNow();
        synchronized (allowedFiles) { allowedFiles.clear(); }
    }
}

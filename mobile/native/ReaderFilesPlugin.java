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

import java.io.InputStream;
import java.util.ArrayDeque;
import java.util.ArrayList;
import java.util.Deque;
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
    // Bound provider traversal and bridge payloads on lower-memory Android devices.
    private static final int MAX_RESULTS = 1200;
    private static final int MAX_ENUMERATED = 20000;
    private static final int MAX_DEPTH = 18;
    private static final long MAX_FILE_BYTES = 64L * 1024L * 1024L;
    private static final int CHUNK_SIZE = 128 * 1024;
    private final ExecutorService io = Executors.newSingleThreadExecutor();
    private final Map<String, Uri> allowedFiles = new HashMap<>();
    private final Map<String, ReadSession> activeReads = new HashMap<>();
    private Uri selectedTree;

    private static final class ReadSession {
        final InputStream input;
        long totalBytes;
        ReadSession(InputStream input) { this.input = input; }
    }

    private static final class ScanNode {
        final String documentId;
        final String prefix;
        final int depth;
        ScanNode(String documentId, String prefix, int depth) {
            this.documentId = documentId; this.prefix = prefix; this.depth = depth;
        }
    }

    private static final class ScanStats {
        int visited;
        int unavailable;
        boolean truncated;
    }

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
        final Uri chosenTree = selectedTree;
        // Metadata providers can block for seconds; never query from Android's UI thread.
        io.execute(() -> {
            JSObject reply = new JSObject();
            reply.put("cancelled", false);
            reply.put("name", folderDisplayName(chosenTree));
            call.resolve(reply);
        });
    }

    @PluginMethod
    public void scanFolder(PluginCall call) {
        final Uri tree = selectedTree;
        if (tree == null) { call.reject("请先选择文件夹"); return; }
        final Set<String> formats = new HashSet<>();
        for (String value : call.getString("extensions", "epub,pdf,txt").split(",")) {
            String ext = value.trim().toLowerCase(Locale.ROOT);
            if (ext.equals("epub") || ext.equals("pdf") || ext.equals("txt")) formats.add(ext);
        }
        final int minimum = Math.max(0, call.getInt("minBytes", 0));
        io.execute(() -> {
            try {
                JSArray results = new JSArray();
                ScanStats stats = new ScanStats();
                synchronized (allowedFiles) { allowedFiles.clear(); }
                scanDocuments(tree, formats, minimum, results, stats);
                JSObject reply = new JSObject();
                reply.put("files", results);
                reply.put("limited", stats.truncated);
                reply.put("visited", stats.visited);
                reply.put("unreadableFolders", stats.unavailable);
                call.resolve(reply);
            } catch (Exception ex) { call.reject("读取目录失败：" + ex.getMessage()); }
        });
    }

    private void scanDocuments(Uri tree, Set<String> formats, int minimum,
                               JSArray results, ScanStats stats) throws Exception {
        // Breadth-first traversal avoids deep recursion and circular virtual folders.
        Deque<ScanNode> queue = new ArrayDeque<>();
        Set<String> visitedFolders = new HashSet<>();
        queue.add(new ScanNode(DocumentsContract.getTreeDocumentId(tree), "", 0));
        String[] fields = {
            DocumentsContract.Document.COLUMN_DOCUMENT_ID,
            DocumentsContract.Document.COLUMN_DISPLAY_NAME,
            DocumentsContract.Document.COLUMN_MIME_TYPE,
            DocumentsContract.Document.COLUMN_SIZE
        };
        while (!queue.isEmpty() && stats.visited < MAX_ENUMERATED && results.length() < MAX_RESULTS) {
            ScanNode node = queue.removeFirst();
            if (!visitedFolders.add(node.documentId) || node.depth > MAX_DEPTH) continue;
            Uri children = DocumentsContract.buildChildDocumentsUriUsingTree(tree, node.documentId);
            try (Cursor cursor = getContext().getContentResolver().query(children, fields, null, null, null)) {
                if (cursor == null) { stats.unavailable++; continue; }
                while (cursor.moveToNext()) {
                    if (++stats.visited > MAX_ENUMERATED) { stats.truncated = true; break; }
                    String id = cursor.getString(0);
                    String name = cursor.getString(1);
                    String mime = cursor.getString(2);
                    long size = cursor.isNull(3) ? -1 : cursor.getLong(3);
                    if (id == null || name == null || name.startsWith(".")) continue;
                    String relative = node.prefix.isEmpty() ? name : node.prefix + "/" + name;
                    if (DocumentsContract.Document.MIME_TYPE_DIR.equals(mime)) {
                        if (node.depth < MAX_DEPTH && queue.size() < MAX_ENUMERATED)
                            queue.addLast(new ScanNode(id, relative, node.depth + 1));
                        continue;
                    }
                    int dot = name.lastIndexOf('.');
                    String ext = dot < 0 ? "" : name.substring(dot + 1).toLowerCase(Locale.ROOT);
                    if (!formats.contains(ext) || size == 0 || size > MAX_FILE_BYTES
                            || (size >= 0 && size < minimum)) continue;
                    String key = UUID.randomUUID().toString();
                    synchronized (allowedFiles) {
                        allowedFiles.put(key, DocumentsContract.buildDocumentUriUsingTree(tree, id));
                    }
                    JSObject record = new JSObject();
                    record.put("key", key);
                    record.put("name", name);
                    record.put("ext", ext);
                    record.put("size", Math.max(0L, size));
                    record.put("relativePath", relative.length() <= 450 ? relative
                        : "…" + relative.substring(relative.length() - 449));
                    results.put(record);
                    if (results.length() >= MAX_RESULTS) { stats.truncated = true; break; }
                }
            } catch (SecurityException ex) {
                if (node.depth == 0) throw ex;
                stats.unavailable++;
            } catch (Exception ex) {
                if (node.depth == 0) throw ex;
                stats.unavailable++;
            }
        }
        if (!queue.isEmpty() || stats.visited >= MAX_ENUMERATED) stats.truncated = true;
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
                JSObject meta = describeFile(uri, false);
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

    @PluginMethod
    public void chooseFonts(PluginCall call) {
        Intent intent = new Intent(Intent.ACTION_OPEN_DOCUMENT);
        intent.setType("*/*");
        intent.addCategory(Intent.CATEGORY_OPENABLE);
        intent.putExtra(Intent.EXTRA_ALLOW_MULTIPLE, true);
        intent.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);
        startActivityForResult(call, intent, "onFontsChosen");
    }

    @ActivityCallback
    private void onFontsChosen(PluginCall call, ActivityResult result) {
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
            for (int i = 0; i < clip.getItemCount() && i < 40; i++) {
                Uri uri = clip.getItemAt(i).getUri();
                if (uri != null) uris.add(uri);
            }
        } else if (data.getData() != null) uris.add(data.getData());
        synchronized (allowedFiles) { allowedFiles.clear(); }
        JSArray files = new JSArray();
        for (Uri uri : uris) {
            try {
                JSObject meta = describeFile(uri, true);
                if (meta == null) continue;
                String key = UUID.randomUUID().toString();
                synchronized (allowedFiles) { allowedFiles.put(key, uri); }
                meta.put("key", key);
                files.put(meta);
            } catch (Exception ignored) { }
        }
        JSObject reply = new JSObject();
        reply.put("cancelled", false);
        reply.put("files", files);
        call.resolve(reply);
    }

    private JSObject describeFile(Uri uri, boolean acceptFonts) {
        String[] columns = { DocumentsContract.Document.COLUMN_DISPLAY_NAME, DocumentsContract.Document.COLUMN_SIZE };
        try (Cursor c = getContext().getContentResolver().query(uri, columns, null, null, null)) {
            if (c == null || !c.moveToFirst()) return null;
            String name = c.getString(0);
            if (name == null) return null;
            int dot = name.lastIndexOf('.');
            String ext = dot < 0 ? "" : name.substring(dot + 1).toLowerCase(Locale.ROOT);
            boolean accepted = acceptFonts
                ? (ext.equals("ttf") || ext.equals("otf") || ext.equals("woff") || ext.equals("woff2"))
                : (ext.equals("epub") || ext.equals("pdf") || ext.equals("txt"));
            if (!accepted) return null;
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
    public void openRead(PluginCall call) {
        String key = call.getString("key", "");
        final Uri uri;
        synchronized (allowedFiles) { uri = allowedFiles.get(key); }
        if (uri == null) { call.reject("文件授权已失效，请重新选择"); return; }
        io.execute(() -> {
            try {
                if (!activeReads.isEmpty()) throw new Exception("已有文件正在读取");
                InputStream input = getContext().getContentResolver().openInputStream(uri);
                if (input == null) throw new Exception("文档提供方无法打开文件");
                String handle = UUID.randomUUID().toString();
                activeReads.put(handle, new ReadSession(input));
                JSObject reply = new JSObject();
                reply.put("handle", handle);
                call.resolve(reply);
            } catch (Exception error) { call.reject("打开文件失败：" + error.getMessage()); }
        });
    }

    @PluginMethod
    public void readChunk(PluginCall call) {
        String handle = call.getString("handle", "");
        io.execute(() -> {
            ReadSession session = activeReads.get(handle);
            if (session == null) { call.reject("读取会话失效"); return; }
            try {
                byte[] bytes = new byte[CHUNK_SIZE];
                int count = session.input.read(bytes);
                if (count == 0) count = session.input.read(bytes);
                if (count == 0) throw new Exception("文件流未返回数据，请重试");
                if (count < 0) {
                    closeSession(handle);
                    JSObject last = new JSObject();
                    last.put("done", true);
                    last.put("base64", "");
                    call.resolve(last);
                    return;
                }
                session.totalBytes += count;
                if (session.totalBytes > MAX_FILE_BYTES)
                    throw new Exception("单个文件超过 64MB 安全上限，可先拆分或压缩");
                JSObject reply = new JSObject();
                reply.put("done", false);
                reply.put("base64", Base64.encodeToString(bytes, 0, count, Base64.NO_WRAP));
                call.resolve(reply);
            } catch (Exception error) {
                closeSession(handle);
                call.reject("文件读取失败：" + error.getMessage());
            }
        });
    }

    private void closeSession(String handle) {
        ReadSession session = activeReads.remove(handle);
        if (session != null) {
            try { session.input.close(); } catch (Exception ignored) { }
        }
    }

    @PluginMethod
    public void closeRead(PluginCall call) {
        String handle = call.getString("handle", "");
        io.execute(() -> {
            closeSession(handle);
            call.resolve();
        });
    }

    @Override
    protected void handleOnDestroy() {
        // ReaderFiles is scoped to the Activity lifecycle, never leave provider handles open.
        for (String handle : new ArrayList<>(activeReads.keySet())) closeSession(handle);
        io.shutdownNow();
        synchronized (allowedFiles) { allowedFiles.clear(); }
    }
}

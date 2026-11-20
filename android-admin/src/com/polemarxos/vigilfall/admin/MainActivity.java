package com.polemarxos.vigilfall.admin;

import android.app.Activity;
import android.app.PendingIntent;
import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.content.IntentFilter;
import android.content.pm.PackageInfo;
import android.content.pm.PackageInstaller;
import android.graphics.Color;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.webkit.JavascriptInterface;
import android.webkit.ValueCallback;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import com.jcraft.jsch.ChannelExec;
import com.jcraft.jsch.JSch;
import com.jcraft.jsch.Session;
import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.util.Arrays;
import java.util.HashMap;
import java.util.Map;
import java.util.Properties;
import org.json.JSONObject;
import android.content.ContentValues;
import android.os.Environment;
import android.provider.MediaStore;
import java.util.Iterator;

public class MainActivity extends Activity {
    static final String HOST = "vigilfall-admin.app";
    static final String REPO = "https://raw.githubusercontent.com/polemarxos/Vigilfall/main/";
    static final String LATEST = REPO + "server/admin/index.html";
    static final String APP_INFO = REPO + "VigilfallAdmin.json";
    static final String VERSION = "1.9";
    static final String ACTION_INSTALLED = "com.polemarxos.vigilfall.admin.INSTALLED";
    static final int PICK = 42;
    WebView web;
    ValueCallback<Uri[]> fileCb;
    long lastAppCheck = 0;
    boolean installing = false;
    final Map<String, Session> running = new HashMap<>();

    // the Realm server hands out the admin page and the app (the GitHub repository may be private)
    String server() { return getSharedPreferences("vfa", MODE_PRIVATE).getString("server", ""); }

    File cached() { return new File(getFilesDir(), "admin.html"); }
    File keyFile() { return new File(getFilesDir(), "ssh.key"); }

    InputStream page() throws Exception {
        File f = cached();
        return f.exists() && f.length() > 5000 ? new FileInputStream(f) : getAssets().open("admin.html");
    }

    static byte[] readAll(InputStream in) throws Exception {
        ByteArrayOutputStream o = new ByteArrayOutputStream();
        byte[] b = new byte[16384];
        int n;
        while ((n = in.read(b)) > 0) o.write(b, 0, n);
        in.close();
        return o.toByteArray();
    }

    static HttpURLConnection open(String url) throws Exception {
        HttpURLConnection c = (HttpURLConnection) new URL(url).openConnection();
        c.setConnectTimeout(10000);
        c.setReadTimeout(30000);
        c.setUseCaches(false);
        c.setInstanceFollowRedirects(true);
        return c;
    }

    void state(String st, String detail) {
        String a = JSONObject.quote(st) + "," + JSONObject.quote(detail == null ? "" : detail);
        js("window.VFA_updateState && VFA_updateState(" + a + "); window.VFA_appState && VFA_appState(" + a + ")");
    }

    void js(final String code) {
        runOnUiThread(new Runnable() { public void run() { if (web != null) web.evaluateJavascript(code, null); } });
    }

    int myVersionCode() {
        try {
            PackageInfo pi = getPackageManager().getPackageInfo(getPackageName(), 0);
            return pi.versionCode;
        } catch (Exception e) {
            return 0;
        }
    }

    // ---------- the admin page updates itself from GitHub ----------
    void checkPage() {
        new Thread(new Runnable() {
            public void run() {
                try {
                    String srv = server();
                    // GitHub first (always the newest); the Realm server only if GitHub cannot be reached
                    HttpURLConnection c = open(LATEST + "?t=" + System.currentTimeMillis());
                    if (c.getResponseCode() != 200 && !srv.isEmpty()) c = open(srv + "/admin?t=" + System.currentTimeMillis());
                    if (c.getResponseCode() != 200) return;
                    byte[] neu = readAll(c.getInputStream());
                    String s = new String(neu, "UTF-8");
                    if (neu.length < 5000 || !s.contains("Vigilfall Admin") || !s.contains("</html>")) return;
                    if (Arrays.equals(readAll(page()), neu)) return;
                    File tmp = new File(getFilesDir(), "admin.html.tmp");
                    FileOutputStream out = new FileOutputStream(tmp);
                    out.write(neu);
                    out.close();
                    if (tmp.renameTo(cached())) js("window.VFA_updated && window.VFA_updated()");
                } catch (Exception e) {
                }
            }
        }).start();
    }

    // ---------- the app updates itself: download the new APK and hand it to Android's installer ----------
    void checkApp(final boolean manual) {
        if (installing) return;
        if (!manual && System.currentTimeMillis() - lastAppCheck < 30 * 60000) return;
        lastAppCheck = System.currentTimeMillis();
        new Thread(new Runnable() {
            public void run() {
                try {
                    String srv = server();
                    HttpURLConnection c = open(APP_INFO + "?t=" + System.currentTimeMillis());
                    if (c.getResponseCode() != 200 && !srv.isEmpty()) c = open(srv + "/VigilfallAdmin.json?t=" + System.currentTimeMillis());
                    if (c.getResponseCode() != 200) return;
                    JSONObject j = new JSONObject(new String(readAll(c.getInputStream()), "UTF-8"));
                    int code = j.optInt("versionCode", 0);
                    if (code <= myVersionCode()) {
                        if (manual) state("current", "");
                        return;
                    }
                    installing = true;
                    state("downloading", "0");
                    String apk = j.getString("apk");
                    if (apk.startsWith("/")) apk = srv + apk;
                    HttpURLConnection d = open(apk + "?t=" + System.currentTimeMillis());
                    d.setReadTimeout(120000);
                    if (d.getResponseCode() != 200) throw new Exception("download " + d.getResponseCode());
                    PackageInstaller pi = getPackageManager().getPackageInstaller();
                    PackageInstaller.SessionParams sp = new PackageInstaller.SessionParams(PackageInstaller.SessionParams.MODE_FULL_INSTALL);
                    sp.setAppPackageName(getPackageName());
                    if (Build.VERSION.SDK_INT >= 31) sp.setRequireUserAction(PackageInstaller.SessionParams.USER_ACTION_NOT_REQUIRED);
                    int id = pi.createSession(sp);
                    PackageInstaller.Session s = pi.openSession(id);
                    OutputStream out = s.openWrite("app.apk", 0, -1);
                    InputStream in = d.getInputStream();
                    byte[] b = new byte[65536];
                    int n;
                    long total = d.getContentLength(), got = 0;
                    int lastPct = -1;
                    while ((n = in.read(b)) > 0) {
                        out.write(b, 0, n);
                        got += n;
                        int pct = total > 0 ? (int) (got * 100 / total) : 0;
                        if (pct >= lastPct + 10) { lastPct = pct; state("downloading", String.valueOf(pct)); }
                    }
                    in.close();
                    s.fsync(out);
                    out.close();
                    Intent cb = new Intent(ACTION_INSTALLED).setPackage(getPackageName());
                    int flags = PendingIntent.FLAG_UPDATE_CURRENT | (Build.VERSION.SDK_INT >= 31 ? 33554432 /* FLAG_MUTABLE */ : 0);
                    PendingIntent p = PendingIntent.getBroadcast(MainActivity.this, id, cb, flags);
                    s.commit(p.getIntentSender());
                    s.close();
                    state("installing", j.optString("versionName"));
                } catch (Exception e) {
                    installing = false;
                    state("failed", String.valueOf(e.getMessage()));
                }
            }
        }).start();
    }

    final BroadcastReceiver installResult = new BroadcastReceiver() {
        @Override
        public void onReceive(Context ctx, Intent i) {
            int st = i.getIntExtra(PackageInstaller.EXTRA_STATUS, -999);
            if (st == PackageInstaller.STATUS_PENDING_USER_ACTION) {
                // Android asks once: "Do you want to update this app?" (and the first time: allow installs from this app)
                Intent confirm = i.getParcelableExtra(Intent.EXTRA_INTENT);
                if (confirm != null) {
                    confirm.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
                    try { startActivity(confirm); } catch (Exception e) {}
                }
                state("confirm", "");
            } else if (st == PackageInstaller.STATUS_SUCCESS) {
                installing = false;
            } else {
                installing = false;
                state("failed", String.valueOf(i.getStringExtra(PackageInstaller.EXTRA_STATUS_MESSAGE)));
            }
        }
    };

    // ---------- bridge for the page: app updates and the SSH console ----------
    class Bridge {
        @JavascriptInterface public String version() { return VERSION; }
        @JavascriptInterface public void setServer(String base) {
            if (base == null || !base.matches("^https?://[A-Za-z0-9.:-]+$")) return;
            getSharedPreferences("vfa", MODE_PRIVATE).edit().putString("server", base).apply();
        }
        @JavascriptInterface public void updateApp() { checkApp(true); }
        @JavascriptInterface public boolean canSelfUpdate() { return true; }
        @JavascriptInterface public void selfUpdate(String url) { checkApp(true); }
        @JavascriptInterface public boolean hasKey() { return keyFile().exists() && keyFile().length() > 100; }
        @JavascriptInterface public String setKey(String pem) {
            try {
                if (pem == null || !pem.contains("PRIVATE KEY")) return "That file is not a private SSH key.";
                FileOutputStream o = new FileOutputStream(keyFile());
                o.write(pem.trim().concat("\n").getBytes("UTF-8"));
                o.close();
                return "";
            } catch (Exception e) {
                return String.valueOf(e.getMessage());
            }
        }
        @JavascriptInterface public void removeKey() { keyFile().delete(); }
        // phone alerts (AlertJob checks the server about every 15 minutes)
        @JavascriptInterface public String getAlerts() {
            android.content.SharedPreferences sp = AlertJob.prefs(MainActivity.this);
            try {
                JSONObject o = new JSONObject();
                o.put("on", sp.getBoolean("on", false));
                o.put("kinds", new JSONObject(sp.getString("kinds", "{\"down\":1,\"cheat\":1,\"email\":1,\"backup\":1,\"world\":1,\"server\":0,\"newplayer\":0}")));
                o.put("lastCheck", sp.getLong("lastCheck", 0));
                o.put("lastError", sp.getString("lastError", ""));
                return o.toString();
            } catch (Exception e) { return "{}"; }
        }
        @JavascriptInterface public String setAlerts(String json) {
            try {
                JSONObject o = new JSONObject(json);
                boolean on = o.optBoolean("on", false);
                String base = o.optString("base", "");
                android.content.SharedPreferences sp = AlertJob.prefs(MainActivity.this);
                android.content.SharedPreferences.Editor ed = sp.edit().putBoolean("on", on).putString("kinds", o.optJSONObject("kinds") != null ? o.optJSONObject("kinds").toString() : "{}");
                if (base.matches("^https?://[A-Za-z0-9.:-]+$")) {
                    if (!base.equals(sp.getString("base", ""))) ed.putLong("after", 0);
                    ed.putString("base", base);
                }
                if (o.has("pw") && !o.optString("pw").isEmpty()) ed.putString("pw", o.optString("pw"));
                ed.apply();
                AlertJob.schedule(MainActivity.this);
                if (on && Build.VERSION.SDK_INT >= 33 && checkSelfPermission("android.permission.POST_NOTIFICATIONS") != android.content.pm.PackageManager.PERMISSION_GRANTED)
                    runOnUiThread(new Runnable() { public void run() { requestPermissions(new String[] { "android.permission.POST_NOTIFICATIONS" }, 77); } });
                return "OK";
            } catch (Exception e) { return "ERR: " + e.getMessage(); }
        }
        @JavascriptInterface public void testAlert() {
            if (Build.VERSION.SDK_INT >= 33 && checkSelfPermission("android.permission.POST_NOTIFICATIONS") != android.content.pm.PackageManager.PERMISSION_GRANTED)
                runOnUiThread(new Runnable() { public void run() { requestPermissions(new String[] { "android.permission.POST_NOTIFICATIONS" }, 77); } });
            AlertJob.notify(MainActivity.this, 2, "Vigilfall · Test alert", "Alerts work. You will see notifications like this one when something happens on your Realm.");
        }
        @JavascriptInterface public void checkAlertsNow() {
            new Thread(new Runnable() { public void run() { AlertJob.check(MainActivity.this); } }).start();
        }
        // app backup: the SSH key, the servers the console trusts and the saved server address (the page encrypts it)
        @JavascriptInterface public String exportData() {
            try {
                JSONObject o = new JSONObject(), hosts = new JSONObject();
                if (keyFile().exists()) o.put("sshKey", new String(readAll(new FileInputStream(keyFile())), "UTF-8"));
                File[] fs = getFilesDir().listFiles();
                if (fs != null) for (File f : fs) if (f.getName().startsWith("host_")) hosts.put(f.getName(), new String(readAll(new FileInputStream(f)), "UTF-8"));
                o.put("hosts", hosts);
                o.put("server", server());
                return o.toString();
            } catch (Exception e) { return "{}"; }
        }
        @JavascriptInterface public String importData(String json) {
            try {
                JSONObject o = new JSONObject(json);
                String key = o.optString("sshKey", "");
                if (key.contains("PRIVATE KEY")) { FileOutputStream w = new FileOutputStream(keyFile()); w.write(key.getBytes("UTF-8")); w.close(); }
                JSONObject hosts = o.optJSONObject("hosts");
                if (hosts != null) for (Iterator<String> it = hosts.keys(); it.hasNext(); ) {
                    String n = it.next();
                    if (!n.matches("^host_[A-Za-z0-9._-]+\\.fp$")) continue;
                    FileOutputStream w = new FileOutputStream(new File(getFilesDir(), n)); w.write(hosts.getString(n).getBytes("UTF-8")); w.close();
                }
                String srv = o.optString("server", "");
                if (srv.matches("^https?://[A-Za-z0-9.:-]+$")) getSharedPreferences("vfa", MODE_PRIVATE).edit().putString("server", srv).apply();
                return "OK";
            } catch (Exception e) { return "ERR: " + e.getMessage(); }
        }
        // save a text file to Downloads (Android 10+) or the app's own Downloads folder
        @JavascriptInterface public String saveFile(String name, String text) {
            try {
                name = name.replaceAll("[^A-Za-z0-9._-]", "_");
                byte[] b = text.getBytes("UTF-8");
                if (Build.VERSION.SDK_INT >= 29) {
                    ContentValues v = new ContentValues();
                    v.put(MediaStore.Downloads.DISPLAY_NAME, name);
                    v.put(MediaStore.Downloads.MIME_TYPE, "application/octet-stream");
                    Uri u = getContentResolver().insert(MediaStore.Downloads.EXTERNAL_CONTENT_URI, v);
                    OutputStream o = getContentResolver().openOutputStream(u);
                    o.write(b); o.close();
                    return "Downloads/" + name;
                }
                File d = getExternalFilesDir(Environment.DIRECTORY_DOWNLOADS);
                d.mkdirs();
                File f = new File(d, name);
                FileOutputStream o = new FileOutputStream(f); o.write(b); o.close();
                return f.getAbsolutePath();
            } catch (Exception e) { return "ERR: " + e.getMessage(); }
        }
        @JavascriptInterface public void forgetServers() {
            File[] fs = getFilesDir().listFiles();
            if (fs != null) for (File f : fs) if (f.getName().startsWith("host_")) f.delete();
        }
        @JavascriptInterface public void cancel(String id) {
            Session s;
            synchronized (running) { s = running.remove(id); }
            if (s != null) try { s.disconnect(); } catch (Exception e) {}
        }
        @JavascriptInterface public void exec(final String id, final String host, final String user, final String cmd) {
            new Thread(new Runnable() {
                public void run() { runSsh(id, host, user, cmd); }
            }).start();
        }
    }

    void runSsh(String id, String host, String user, String cmd) {
        String q = JSONObject.quote(id);
        Session s = null;
        int exit = -1;
        try {
            if (!keyFile().exists()) throw new Exception("No SSH key on this phone yet.");
            JSch j = new JSch();
            j.addIdentity(keyFile().getAbsolutePath());
            s = j.getSession(user, host, 22);
            Properties cfg = new Properties();
            cfg.put("StrictHostKeyChecking", "no"); // checked below: the server's key is remembered on first use
            cfg.put("PreferredAuthentications", "publickey");
            s.setConfig(cfg);
            s.setServerAliveInterval(20000);
            s.connect(15000);
            // trust on first use: remember this server's key; a different key later means another machine answers
            String fp = s.getHostKey().getFingerPrint(j);
            File fpf = new File(getFilesDir(), "host_" + host.replaceAll("[^A-Za-z0-9.-]", "_") + ".fp");
            if (!fpf.exists()) {
                FileOutputStream o = new FileOutputStream(fpf);
                o.write(fp.getBytes("UTF-8"));
                o.close();
            } else if (!new String(readAll(new FileInputStream(fpf)), "UTF-8").trim().equals(fp)) {
                throw new Exception("This server's identity changed (a new server at this address?). If you moved the Realm, tap Forget server in the console and try again.");
            }
            synchronized (running) { running.put(id, s); }
            ChannelExec ch = (ChannelExec) s.openChannel("exec");
            ch.setCommand(cmd);
            ch.setInputStream(null);
            ch.setErrStream(null);
            InputStream out = ch.getInputStream();
            InputStream err = ch.getErrStream();
            ch.connect(15000);
            byte[] b = new byte[8192];
            while (true) {
                boolean any = false;
                while (out.available() > 0) { int n = out.read(b); if (n < 0) break; any = true; js("VFA_sshOut(" + q + "," + JSONObject.quote(new String(b, 0, n, "UTF-8")) + ")"); }
                while (err.available() > 0) { int n = err.read(b); if (n < 0) break; any = true; js("VFA_sshOut(" + q + "," + JSONObject.quote(new String(b, 0, n, "UTF-8")) + ")"); }
                if (ch.isClosed()) {
                    if (out.available() > 0 || err.available() > 0) continue;
                    exit = ch.getExitStatus();
                    break;
                }
                if (!s.isConnected()) break;
                if (!any) Thread.sleep(80);
            }
            ch.disconnect();
        } catch (Exception e) {
            js("VFA_sshOut(" + q + "," + JSONObject.quote("\n⚠ " + e.getMessage() + "\n") + ")");
        } finally {
            synchronized (running) { running.remove(id); }
            if (s != null) try { s.disconnect(); } catch (Exception e) {}
            js("VFA_sshDone(" + q + "," + exit + ")");
        }
    }

    @Override
    protected void onCreate(Bundle b) {
        super.onCreate(b);
        if (Build.VERSION.SDK_INT >= 33) registerReceiver(installResult, new IntentFilter(ACTION_INSTALLED), 4 /* RECEIVER_NOT_EXPORTED */);
        else registerReceiver(installResult, new IntentFilter(ACTION_INSTALLED));
        web = new WebView(this);
        web.setBackgroundColor(Color.rgb(20, 17, 13));
        WebSettings s = web.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);
        s.setDatabaseEnabled(true);
        s.setSupportZoom(false);
        s.setBuiltInZoomControls(false);
        s.setMixedContentMode(WebSettings.MIXED_CONTENT_ALWAYS_ALLOW);
        s.setUserAgentString(s.getUserAgentString() + " VigilfallAdmin/" + VERSION);
        web.setOverScrollMode(WebView.OVER_SCROLL_NEVER);
        web.addJavascriptInterface(new Bridge(), "VFAApp");
        web.setWebViewClient(new WebViewClient() {
            @Override
            public WebResourceResponse shouldInterceptRequest(WebView v, WebResourceRequest r) {
                if (HOST.equals(r.getUrl().getHost())) {
                    try {
                        return new WebResourceResponse("text/html", "utf-8", page());
                    } catch (Exception e) {
                        return null;
                    }
                }
                return null;
            }

            @Override
            public boolean shouldOverrideUrlLoading(WebView v, WebResourceRequest r) {
                if (!HOST.equals(r.getUrl().getHost())) {
                    try { startActivity(new Intent(Intent.ACTION_VIEW, r.getUrl())); } catch (Exception e) {}
                    return true;
                }
                return false;
            }
        });
        web.setWebChromeClient(new WebChromeClient() {
            @Override
            public boolean onShowFileChooser(WebView v, ValueCallback<Uri[]> cb, FileChooserParams params) {
                if (fileCb != null) fileCb.onReceiveValue(null);
                fileCb = cb;
                Intent i = new Intent(Intent.ACTION_GET_CONTENT);
                i.addCategory(Intent.CATEGORY_OPENABLE);
                i.setType("*/*");
                try {
                    startActivityForResult(Intent.createChooser(i, "Choose a file"), PICK);
                } catch (Exception e) {
                    fileCb = null;
                    return false;
                }
                return true;
            }
        });
        setContentView(web);
        if (b != null) web.restoreState(b);
        else web.loadUrl("https://" + HOST + "/");
        checkPage();
    }

    @Override
    protected void onResume() {
        super.onResume();
        if (web != null) web.postDelayed(new Runnable() { public void run() { checkPage(); checkApp(false); js("window.VFA_resume && VFA_resume()"); } }, 1500);
    }

    @Override
    protected void onDestroy() {
        try { unregisterReceiver(installResult); } catch (Exception e) {}
        super.onDestroy();
    }

    @Override
    protected void onActivityResult(int req, int res, Intent data) {
        super.onActivityResult(req, res, data);
        if (req == PICK && fileCb != null) {
            Uri[] r = null;
            if (res == RESULT_OK && data != null && data.getData() != null) r = new Uri[] { data.getData() };
            fileCb.onReceiveValue(r);
            fileCb = null;
        }
    }

    @Override
    protected void onSaveInstanceState(Bundle o) {
        super.onSaveInstanceState(o);
        web.saveState(o);
    }

    @Override
    public void onBackPressed() {
        web.evaluateJavascript("(window.VFA_back && window.VFA_back()) ? 'y' : 'n'", new ValueCallback<String>() {
            @Override
            public void onReceiveValue(String v) {
                if (v == null || !v.contains("y")) MainActivity.super.onBackPressed();
            }
        });
    }
}

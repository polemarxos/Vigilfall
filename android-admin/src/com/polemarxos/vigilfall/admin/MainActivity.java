package com.polemarxos.vigilfall.admin;

import android.app.Activity;
import android.app.PendingIntent;
import android.content.Intent;
import android.content.pm.PackageInfo;
import android.content.pm.PackageInstaller;
import android.graphics.Color;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.provider.Settings;
import android.webkit.JavascriptInterface;
import android.webkit.ValueCallback;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.util.Arrays;

public class MainActivity extends Activity {
    static final String HOST = "vigilfall-admin.app";
    static final String LATEST = "https://raw.githubusercontent.com/polemarxos/Vigilfall/main/server/admin/index.html";
    static final String VERSION = "1.4";
    static final String ACT_INSTALL = "com.polemarxos.vigilfall.admin.INSTALLED";
    static final int PICK = 42;
    WebView web;
    ValueCallback<Uri[]> fileCb;
    volatile boolean updating = false;

    File cached() { return new File(getFilesDir(), "admin.html"); }

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

    void js(final String code) {
        runOnUiThread(new Runnable() { public void run() { if (web != null) web.evaluateJavascript(code, null); } });
    }

    static String q(String s) { return "'" + String.valueOf(s).replace("\\", "\\\\").replace("'", "\\'").replace("\n", " ") + "'"; }

    void state(String st, String detail) { js("window.VFA_updateState && window.VFA_updateState(" + q(st) + "," + q(detail) + ")"); }

    // the admin page updates itself: the newest one is downloaded from GitHub and used from then on
    void checkUpdate() {
        new Thread(new Runnable() {
            public void run() {
                try {
                    HttpURLConnection c = (HttpURLConnection) new URL(LATEST + "?t=" + System.currentTimeMillis()).openConnection();
                    c.setConnectTimeout(10000);
                    c.setReadTimeout(20000);
                    c.setUseCaches(false);
                    if (c.getResponseCode() != 200) return;
                    byte[] neu = readAll(c.getInputStream());
                    String s = new String(neu, "UTF-8");
                    if (neu.length < 5000 || !s.contains("Vigilfall Admin") || !s.contains("</html>")) return;
                    byte[] cur = readAll(page());
                    if (Arrays.equals(cur, neu)) return;
                    File tmp = new File(getFilesDir(), "admin.html.tmp");
                    FileOutputStream out = new FileOutputStream(tmp);
                    out.write(neu);
                    out.close();
                    if (!tmp.renameTo(cached())) return;
                    js("window.VFA_updated && window.VFA_updated()");
                } catch (Exception e) {
                }
            }
        }).start();
    }

    // the app itself: download the new APK and hand it to Android's installer (Android always asks for one tap)
    void selfUpdate(final String url) {
        if (updating) return;
        if (Build.VERSION.SDK_INT >= 26 && !getPackageManager().canRequestPackageInstalls()) {
            state("permission", "");
            try {
                startActivity(new Intent(Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES, Uri.parse("package:" + getPackageName())));
            } catch (Exception e) {}
            return;
        }
        updating = true;
        new Thread(new Runnable() {
            public void run() {
                try {
                    state("downloading", "0");
                    HttpURLConnection c = (HttpURLConnection) new URL(url + (url.contains("?") ? "&" : "?") + "t=" + System.currentTimeMillis()).openConnection();
                    c.setInstanceFollowRedirects(true);
                    c.setConnectTimeout(15000);
                    c.setReadTimeout(30000);
                    if (c.getResponseCode() != 200) throw new Exception("download failed (" + c.getResponseCode() + ")");
                    int total = c.getContentLength();
                    File apk = new File(getCacheDir(), "update.apk");
                    InputStream in = c.getInputStream();
                    FileOutputStream out = new FileOutputStream(apk);
                    byte[] b = new byte[65536];
                    int n, got = 0, last = -1;
                    while ((n = in.read(b)) > 0) {
                        out.write(b, 0, n);
                        got += n;
                        int pct = total > 0 ? got * 100 / total : 0;
                        if (pct / 10 != last) { last = pct / 10; state("downloading", String.valueOf(pct)); }
                    }
                    out.close();
                    in.close();
                    PackageInfo mine = getPackageManager().getPackageInfo(getPackageName(), 0);
                    PackageInfo neu = getPackageManager().getPackageArchiveInfo(apk.getPath(), 0);
                    if (neu == null || !getPackageName().equals(neu.packageName)) throw new Exception("the downloaded file is not the Vigilfall Admin app");
                    if (neu.versionCode <= mine.versionCode) { state("current", neu.versionName); return; }
                    state("installing", neu.versionName);
                    PackageInstaller pi = getPackageManager().getPackageInstaller();
                    PackageInstaller.SessionParams params = new PackageInstaller.SessionParams(PackageInstaller.SessionParams.MODE_FULL_INSTALL);
                    params.setAppPackageName(getPackageName());
                    int id = pi.createSession(params);
                    PackageInstaller.Session s = pi.openSession(id);
                    OutputStream os = s.openWrite("vigilfall-admin", 0, apk.length());
                    InputStream fin = new FileInputStream(apk);
                    while ((n = fin.read(b)) > 0) os.write(b, 0, n);
                    fin.close();
                    s.fsync(os);
                    os.close();
                    Intent done = new Intent(MainActivity.this, MainActivity.class).setAction(ACT_INSTALL);
                    int fl = PendingIntent.FLAG_UPDATE_CURRENT | (Build.VERSION.SDK_INT >= 31 ? PendingIntent.FLAG_MUTABLE : 0);
                    PendingIntent p = PendingIntent.getActivity(MainActivity.this, 7, done, fl);
                    s.commit(p.getIntentSender());
                    s.close();
                } catch (Exception e) {
                    state("failed", e.getMessage());
                } finally {
                    updating = false;
                }
            }
        }).start();
    }

    @Override
    protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        if (intent != null && ACT_INSTALL.equals(intent.getAction())) {
            int st = intent.getIntExtra(PackageInstaller.EXTRA_STATUS, PackageInstaller.STATUS_FAILURE);
            if (st == PackageInstaller.STATUS_PENDING_USER_ACTION) {
                Intent confirm = (Intent) intent.getParcelableExtra(Intent.EXTRA_INTENT);
                if (confirm != null) { confirm.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK); startActivity(confirm); }
            } else if (st != PackageInstaller.STATUS_SUCCESS) {
                state("failed", intent.getStringExtra(PackageInstaller.EXTRA_STATUS_MESSAGE));
            }
        }
    }

    public class Bridge {
        @JavascriptInterface public String version() { return VERSION; }
        @JavascriptInterface public void selfUpdate(String url) { MainActivity.this.selfUpdate(url); }
        @JavascriptInterface public boolean canSelfUpdate() { return true; }
    }

    @Override
    protected void onCreate(Bundle b) {
        super.onCreate(b);
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
                // links to other sites (downloads) open in the browser
                if (!HOST.equals(r.getUrl().getHost())) {
                    try { startActivity(new Intent(Intent.ACTION_VIEW, r.getUrl())); } catch (Exception e) {}
                    return true;
                }
                return false;
            }
        });
        // "Upload a backup…" opens the phone's file picker
        web.setWebChromeClient(new WebChromeClient() {
            @Override
            public boolean onShowFileChooser(WebView v, ValueCallback<Uri[]> cb, FileChooserParams params) {
                if (fileCb != null) fileCb.onReceiveValue(null);
                fileCb = cb;
                Intent i = new Intent(Intent.ACTION_GET_CONTENT);
                i.addCategory(Intent.CATEGORY_OPENABLE);
                i.setType("*/*");
                try {
                    startActivityForResult(Intent.createChooser(i, "Choose a Realm backup (.tgz)"), PICK);
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
        checkUpdate();
    }

    @Override
    protected void onResume() {
        super.onResume();
        if (web != null) web.postDelayed(new Runnable() { public void run() { checkUpdate(); js("window.VFA_resume && window.VFA_resume()"); } }, 1500);
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

package com.polemarxos.vigilfall.admin;

import android.app.Activity;
import android.content.Intent;
import android.graphics.Color;
import android.net.Uri;
import android.os.Bundle;
import android.webkit.ValueCallback;
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
import java.net.HttpURLConnection;
import java.net.URL;
import java.util.Arrays;

public class MainActivity extends Activity {
    static final String HOST = "vigilfall-admin.app";
    static final String LATEST = "https://raw.githubusercontent.com/polemarxos/Vigilfall/main/server/admin/index.html";
    static final String VERSION = "1.2";
    WebView web;

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
                    runOnUiThread(new Runnable() {
                        public void run() {
                            web.evaluateJavascript("window.VFA_updated && window.VFA_updated()", null);
                        }
                    });
                } catch (Exception e) {
                }
            }
        }).start();
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
                // links to other sites (e.g. a new app download) open in the browser
                if (!HOST.equals(r.getUrl().getHost())) {
                    try { startActivity(new Intent(Intent.ACTION_VIEW, r.getUrl())); } catch (Exception e) {}
                    return true;
                }
                return false;
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
        if (web != null) web.postDelayed(new Runnable() { public void run() { checkUpdate(); } }, 1500);
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

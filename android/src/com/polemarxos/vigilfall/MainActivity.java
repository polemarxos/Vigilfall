package com.polemarxos.vigilfall;

import android.Manifest;
import android.app.Activity;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.graphics.Color;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.view.View;
import android.view.WindowManager;
import android.webkit.PermissionRequest;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceError;
import android.webkit.WebResourceRequest;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.Toast;

/* Vigilfall for Android: a full-screen WebView on the game's website, so every game update arrives without a new APK. */
public class MainActivity extends Activity {
    static final String URL = "https://polemarxos.github.io/Vigilfall/";
    WebView web;
    PermissionRequest pending;
    long lastBack;

    @Override
    protected void onCreate(Bundle b) {
        super.onCreate(b);
        getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
        if (Build.VERSION.SDK_INT >= 28) getWindow().getAttributes().layoutInDisplayCutoutMode = WindowManager.LayoutParams.LAYOUT_IN_DISPLAY_CUTOUT_MODE_SHORT_EDGES;
        web = new WebView(this);
        web.setBackgroundColor(Color.BLACK);
        WebSettings s = web.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);
        s.setDatabaseEnabled(true);
        s.setMediaPlaybackRequiresUserGesture(false);
        s.setCacheMode(WebSettings.LOAD_DEFAULT);
        s.setUserAgentString(s.getUserAgentString() + " VigilfallApp/1.0");
        web.setWebViewClient(new WebViewClient() {
            @Override
            public boolean shouldOverrideUrlLoading(WebView v, WebResourceRequest r) {
                Uri u = r.getUrl();
                if ("polemarxos.github.io".equals(u.getHost())) return false;
                try { startActivity(new Intent(Intent.ACTION_VIEW, u)); } catch (Exception e) {}
                return true;
            }
            @Override
            public void onReceivedError(WebView v, WebResourceRequest r, WebResourceError e) {
                if (r.isForMainFrame())
                    v.loadData("<html><body style='background:#0b0806;color:#e8d4a0;font:18px Georgia,serif;display:flex;align-items:center;justify-content:center;height:100vh;margin:0;text-align:center'><div>Vigilfall needs an internet connection.<br><br><a style='color:#ffd070' href='" + URL + "'>Try again</a></div></body></html>", "text/html", "utf-8");
            }
        });
        web.setWebChromeClient(new WebChromeClient() {
            @Override
            public void onPermissionRequest(final PermissionRequest req) {
                runOnUiThread(new Runnable() { public void run() {
                    if (checkSelfPermission(Manifest.permission.RECORD_AUDIO) == PackageManager.PERMISSION_GRANTED) req.grant(req.getResources());
                    else { pending = req; requestPermissions(new String[]{Manifest.permission.RECORD_AUDIO}, 7); }
                }});
            }
        });
        setContentView(web);
        immersive();
        if (b != null) web.restoreState(b); else web.loadUrl(URL);
    }

    void immersive() {
        web.setSystemUiVisibility(View.SYSTEM_UI_FLAG_IMMERSIVE_STICKY | View.SYSTEM_UI_FLAG_FULLSCREEN | View.SYSTEM_UI_FLAG_HIDE_NAVIGATION
            | View.SYSTEM_UI_FLAG_LAYOUT_FULLSCREEN | View.SYSTEM_UI_FLAG_LAYOUT_HIDE_NAVIGATION | View.SYSTEM_UI_FLAG_LAYOUT_STABLE);
    }

    @Override
    public void onWindowFocusChanged(boolean f) { super.onWindowFocusChanged(f); if (f) immersive(); }

    @Override
    public void onRequestPermissionsResult(int code, String[] p, int[] r) {
        if (pending != null) {
            if (r.length > 0 && r[0] == PackageManager.PERMISSION_GRANTED) pending.grant(pending.getResources()); else pending.deny();
            pending = null;
        }
    }

    // Back = Esc in the game (pause menu / close a window); twice quickly leaves the app
    @Override
    public void onBackPressed() {
        long now = System.currentTimeMillis();
        if (now - lastBack < 1200) { super.onBackPressed(); return; }
        lastBack = now;
        web.evaluateJavascript("(function(){var o={key:'Escape',code:'Escape',keyCode:27,which:27,bubbles:true};document.dispatchEvent(new KeyboardEvent('keydown',o));setTimeout(function(){document.dispatchEvent(new KeyboardEvent('keyup',o));},60);})()", null);
        Toast.makeText(this, "Press back again to leave", Toast.LENGTH_SHORT).show();
    }

    @Override protected void onPause() { super.onPause(); web.onPause(); }
    @Override protected void onResume() { super.onResume(); web.onResume(); immersive(); }
    @Override protected void onSaveInstanceState(Bundle o) { super.onSaveInstanceState(o); web.saveState(o); }
}

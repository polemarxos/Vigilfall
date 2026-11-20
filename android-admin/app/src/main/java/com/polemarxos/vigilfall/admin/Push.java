package com.polemarxos.vigilfall.admin;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.os.Build;
import com.google.firebase.FirebaseApp;
import com.google.firebase.FirebaseOptions;
import com.google.firebase.messaging.FirebaseMessaging;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import org.json.JSONObject;

// Firebase Cloud Messaging: the Realm server pushes alerts the moment they happen.
// The Firebase project (from the admin's google-services.json) is set at run time, so no rebuild is needed per server.
public class Push {
    static final String CH = "realm_alerts";
    interface TokenCb { void done(String token, String error); }

    static SharedPreferences prefs(Context c) { return c.getSharedPreferences("fcm", Context.MODE_PRIVATE); }

    static boolean configured(Context c) { return !prefs(c).getString("appId", "").isEmpty(); }

    static synchronized boolean init(Context c) {
        SharedPreferences p = prefs(c);
        if (!configured(c)) return false;
        if (!FirebaseApp.getApps(c).isEmpty()) return true;
        FirebaseOptions o = new FirebaseOptions.Builder()
            .setApiKey(p.getString("apiKey", ""))
            .setApplicationId(p.getString("appId", ""))
            .setProjectId(p.getString("projectId", ""))
            .setGcmSenderId(p.getString("senderId", ""))
            .build();
        FirebaseApp.initializeApp(c.getApplicationContext(), o);
        return true;
    }

    static void token(Context c, final TokenCb cb) {
        try {
            if (!init(c)) { cb.done("", "Firebase is not set up in this app yet."); return; }
            FirebaseMessaging.getInstance().setAutoInitEnabled(true);
            final Context app = c.getApplicationContext();
            FirebaseMessaging.getInstance().getToken().addOnCompleteListener(t -> {
                if (t.isSuccessful() && t.getResult() != null) { prefs(app).edit().putString("token", t.getResult()).apply(); cb.done(t.getResult(), null); }
                else cb.done("", t.getException() != null ? String.valueOf(t.getException().getMessage()) : "no token");
            });
        } catch (Throwable e) { cb.done("", String.valueOf(e.getMessage())); }
    }

    // a new token: tell the Realm server (with the server address and admin password the app keeps)
    static void report(Context c, String token) {
        SharedPreferences p = prefs(c);
        String base = p.getString("base", ""), pw = p.getString("pw", "");
        if (base.isEmpty() || pw.isEmpty() || token == null || token.isEmpty()) return;
        try {
            JSONObject b = new JSONObject();
            b.put("token", token);
            b.put("name", Build.MANUFACTURER + " " + Build.MODEL);
            String kinds = p.getString("kinds", "");
            if (!kinds.isEmpty()) b.put("kinds", new JSONObject(kinds));
            HttpURLConnection h = (HttpURLConnection) new URL(base + "/api/fcm/devices").openConnection();
            h.setConnectTimeout(15000); h.setReadTimeout(20000);
            h.setRequestMethod("POST"); h.setDoOutput(true);
            h.setRequestProperty("Content-Type", "application/json");
            h.setRequestProperty("Authorization", "Bearer " + pw);
            OutputStream o = h.getOutputStream(); o.write(b.toString().getBytes("UTF-8")); o.close();
            h.getResponseCode();
        } catch (Exception e) {}
    }

    static void channel(Context c) {
        if (Build.VERSION.SDK_INT < 26) return;
        NotificationManager nm = (NotificationManager) c.getSystemService(Context.NOTIFICATION_SERVICE);
        NotificationChannel ch = new NotificationChannel(CH, "Realm alerts", NotificationManager.IMPORTANCE_HIGH);
        ch.setDescription("Your Vigilfall Realm server: restarts, anti-cheat, email, backups");
        nm.createNotificationChannel(ch);
    }

    static void notify(Context c, int id, String title, String text) {
        channel(c);
        Intent open = new Intent(c, MainActivity.class).setFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_SINGLE_TOP);
        PendingIntent pi = PendingIntent.getActivity(c, 0, open, PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
        Notification.Builder b = Build.VERSION.SDK_INT >= 26 ? new Notification.Builder(c, CH) : new Notification.Builder(c);
        b.setSmallIcon(R.drawable.ic_stat).setContentTitle(title).setContentText(text)
            .setStyle(new Notification.BigTextStyle().bigText(text)).setAutoCancel(true).setContentIntent(pi)
            .setColor(0xFFE0B860).setWhen(System.currentTimeMillis()).setShowWhen(true);
        if (Build.VERSION.SDK_INT < 26) b.setPriority(Notification.PRIORITY_HIGH).setDefaults(Notification.DEFAULT_ALL);
        ((NotificationManager) c.getSystemService(Context.NOTIFICATION_SERVICE)).notify(id, b.build());
    }
}

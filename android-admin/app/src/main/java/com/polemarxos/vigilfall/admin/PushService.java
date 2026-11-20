package com.polemarxos.vigilfall.admin;

import com.google.firebase.messaging.FirebaseMessagingService;
import com.google.firebase.messaging.RemoteMessage;
import java.util.Map;

public class PushService extends FirebaseMessagingService {
    @Override public void onMessageReceived(RemoteMessage m) {
        Map<String, String> d = m.getData();
        String title = d.get("title"), body = d.get("body");
        if (title == null && m.getNotification() != null) { title = m.getNotification().getTitle(); body = m.getNotification().getBody(); }
        if (title == null) return;
        int id = 1000 + (int) (System.currentTimeMillis() / 1000 % 100000);
        Push.notify(this, id, title, body == null ? "" : body);
    }
    @Override public void onNewToken(final String token) {
        Push.prefs(this).edit().putString("token", token).apply();
        new Thread(() -> Push.report(PushService.this, token)).start();
    }
}

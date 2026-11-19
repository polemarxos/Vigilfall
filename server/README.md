# Vigilfall Realm server

One shared online world for Vigilfall, plus cloud saves and an admin API.

- `realm.js`: the server. It relays players (WebSocket `/realm`), stores saves in `data/players`, keeps backups in `data/backups`, serves `/health`, `/admin` and the admin API (`/api/*`, Bearer password), and supervises the world.
- `host.js`: the world itself. This is the real game (`game/index.html`, downloaded from GitHub Pages) running in a headless Chromium as the Realm host. It does no rendering and runs 20 ticks a second.
- `admin/index.html`: the admin panel. It is served at `/admin` and is also bundled in the *Vigilfall Admin* Android app.
- `setup.sh`: installs everything on Ubuntu (Node 22, Caddy for HTTPS, Chromium, a systemd service, firewall rules) and updates the server when you run it again.

## Install (Oracle Cloud Always Free, Ubuntu 22.04/24.04)

1. Get a free name at https://www.duckdns.org and point it to the server's public IP.
2. In the Oracle console, add ingress rules for TCP **80** and **443** (VCN > Security Lists).
3. On the server, run:

   ```
   curl -fsSL https://raw.githubusercontent.com/polemarxos/Vigilfall/main/server/setup.sh | sudo bash
   ```

4. The script prints the admin password. In the game, press ⚙ next to **Enter the Realm** and type your domain. In the admin app, use the same domain with that password.

To update the server code later, run the same command again.

## Limits

A 2-core / 12 GB Arm server comfortably runs one world. A few dozen players at once is easy, and roughly 100–200 is the practical ceiling, depending on how spread out they are. Change the player cap in the admin app (*Server > Most players at once*).

## Files

- `data/config.json`: name, message of the day, admin password, player cap, auto-update.
- `data/players/<code>.json`: each character (the save, device link, ban state).
- `data/backups/<code>/`: the last 20 backups per character (hourly while playing, and before every admin change).

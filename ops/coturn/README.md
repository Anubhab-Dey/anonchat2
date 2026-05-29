# AnonChat TURN Deployment

Video calls must stay on WebRTC. The server fallback is intentionally audio-only because custom app-server video chunks would need a real SFU/WebRTC relay layer to be correct. For private video calls over the internet, run coturn at `turn.anubhabdey.com` and let the AnonChat app server generate short-lived TURN credentials from `ANONCHAT_TURN_SECRET`.

## Network

Create DNS records first:

```text
turn.anubhabdey.com A    187.127.131.227
turn.anubhabdey.com AAAA 2a02:4780:63:6b7d::1
```

Open these ports to the coturn host:

- TCP/UDP `3478` for TURN.
- TCP `5349` for TURN over TLS.
- UDP `5349` for TURN over DTLS.
- UDP `49160-49200` for relay media, or use a larger range for more concurrent calls.

Use HTTPS/WSS for the AnonChat app when deploying outside localhost.

## Ubuntu VPS With nginx And snap certbot

Install coturn:

```bash
sudo apt update
sudo apt install -y coturn
```

Make sure nginx has an HTTP server block for the TURN hostname so snap certbot can issue the certificate:

```bash
sudo tee /etc/nginx/sites-available/turn.anubhabdey.com >/dev/null <<'EOF'
server {
    listen 80;
    listen [::]:80;
    server_name turn.anubhabdey.com;

    location / {
        return 204;
    }
}
EOF

sudo ln -sf /etc/nginx/sites-available/turn.anubhabdey.com /etc/nginx/sites-enabled/turn.anubhabdey.com
sudo nginx -t
sudo systemctl reload nginx
```

Issue the certificate with snap certbot's nginx plugin:

```bash
sudo certbot --nginx -d turn.anubhabdey.com
```

coturn usually runs as the `turnserver` user and cannot safely read Let's Encrypt private keys directly. Copy the renewed cert into a coturn-owned directory with a deploy hook:

```bash
sudo install -d -m 755 /etc/letsencrypt/renewal-hooks/deploy

sudo tee /etc/letsencrypt/renewal-hooks/deploy/coturn-cert-copy.sh >/dev/null <<'EOF'
#!/usr/bin/env bash
set -euo pipefail

DOMAIN=turn.anubhabdey.com
SRC=/etc/letsencrypt/live/$DOMAIN
DST=/etc/turnserver/certs/$DOMAIN

install -d -o turnserver -g turnserver -m 750 "$DST"
install -o turnserver -g turnserver -m 640 "$SRC/fullchain.pem" "$DST/fullchain.pem"
install -o turnserver -g turnserver -m 640 "$SRC/privkey.pem" "$DST/privkey.pem"

systemctl restart coturn
EOF

sudo chmod +x /etc/letsencrypt/renewal-hooks/deploy/coturn-cert-copy.sh
sudo /etc/letsencrypt/renewal-hooks/deploy/coturn-cert-copy.sh
```

Generate the shared secret used for short-lived TURN credentials:

```bash
openssl rand -hex 32
```

Enable coturn on Ubuntu:

```bash
sudo sed -i 's/^#\?TURNSERVER_ENABLED=.*/TURNSERVER_ENABLED=1/' /etc/default/coturn
```

If that line does not exist, add it:

```bash
echo 'TURNSERVER_ENABLED=1' | sudo tee -a /etc/default/coturn
```

## coturn Config

Copy `ops/coturn/turnserver.conf.example` to your server's coturn config path and replace:

- `static-auth-secret`
- relay port range, if you expect more concurrent calls

TURN does not decrypt WebRTC media. It relays DTLS-SRTP packets between browsers. It can still see participant IP addresses, timing, and packet sizes.

Start coturn:

```bash
sudo systemctl enable --now coturn
sudo systemctl status coturn --no-pager
```

Open Ubuntu firewall ports if UFW is enabled:

```bash
sudo ufw allow 3478/tcp
sudo ufw allow 3478/udp
sudo ufw allow 5349/tcp
sudo ufw allow 5349/udp
sudo ufw allow 49160:49200/udp
```

Also open those ports in your VPS provider firewall/security group.

## AnonChat App Server

Set the same shared secret on the AnonChat app server. The browser will fetch short-lived credentials from `/turn-credentials.json`, so you do not manually edit TURN usernames/passwords into `web/local-config.js`.

For a manual foreground run on Ubuntu:

```bash
export ANONCHAT_TURN_SECRET='replace-with-the-same-static-auth-secret'
export ANONCHAT_TURN_HOST='turn.anubhabdey.com'
export ANONCHAT_TURN_TTL_SECONDS=3600
./build-linux/anonchat
```

For a systemd service, add an override:

```bash
sudo systemctl edit anonchat
```

Then add:

```ini
[Service]
Environment=ANONCHAT_TURN_SECRET=replace-with-the-same-static-auth-secret
Environment=ANONCHAT_TURN_HOST=turn.anubhabdey.com
Environment=ANONCHAT_TURN_TTL_SECONDS=3600
```

Restart:

```bash
sudo systemctl daemon-reload
sudo systemctl restart anonchat
```

On Windows PowerShell for local development:

```powershell
$env:ANONCHAT_TURN_SECRET = "replace-with-the-same-static-auth-secret"
$env:ANONCHAT_TURN_HOST = "turn.anubhabdey.com"
$env:ANONCHAT_TURN_TTL_SECONDS = "3600"
.\build\anonchat.exe
```

Verify:

```bash
curl http://127.0.0.1:8080/turn-credentials.json
```

The response should contain `turns:turn.anubhabdey.com:5349`, a generated `username`, and a generated `credential`. Do not log or paste the shared secret.

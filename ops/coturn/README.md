# AnonChat TURN Deployment

Video calls must stay on WebRTC. The server fallback is intentionally audio-only because custom app-server video chunks would need a real SFU/WebRTC relay layer to be correct. For private video calls over the internet, run coturn at `turn.anubhabdey.com` and serve those TURN URLs through `web/local-config.js`.

## Network

Create an `A` record first:

```text
turn.anubhabdey.com -> YOUR_PUBLIC_VPS_IP
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

- `YOUR_PUBLIC_VPS_IP`
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

## Browser Config

Copy `web/local-config.example.js` to `web/local-config.js` on the deployed AnonChat server and put the TURN URLs and short-lived credentials there. The file is ignored by git and is loaded after `web/config.js`.

Example credential generation for coturn REST credentials:

```powershell
$secret = "replace-with-your-static-auth-secret"
$expiry = [DateTimeOffset]::UtcNow.AddHours(1).ToUnixTimeSeconds()
$username = "$expiry:anonchat"
$hmac = [System.Security.Cryptography.HMACSHA1]::new([Text.Encoding]::UTF8.GetBytes($secret))
$credential = [Convert]::ToBase64String($hmac.ComputeHash([Text.Encoding]::UTF8.GetBytes($username)))
$username
$credential
```

Put the generated values into `web/local-config.js`:

```js
window.ANONCHAT_CONFIG = {
  ...(window.ANONCHAT_CONFIG || {}),
  iceServers: [
    {
      urls: [
        "turns:turn.anubhabdey.com:5349?transport=tcp",
        "turn:turn.anubhabdey.com:3478?transport=udp"
      ],
      username: "generated-expiry:anonchat",
      credential: "generated-hmac"
    }
  ],
  callTransport: "p2p_first",
  relayFallbackEnabled: true,
  backendRelayFallbackEnabled: true,
  turnRequiredForFallback: true
};
```

For production, generate these credentials server-side and refresh them often. Static TURN credentials are acceptable for a private prototype, but they can be copied by any browser that loads the app.

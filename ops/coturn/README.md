# AnonChat TURN Deployment

Video calls must stay on WebRTC. The server fallback is intentionally audio-only because custom app-server video chunks would need a real SFU/WebRTC relay layer to be correct. For private video calls over the internet, run a first-party TURN server and serve those TURN URLs through `web/local-config.js`.

## Network

Open these ports to the coturn host:

- TCP/UDP `3478` for TURN.
- TCP `5349` for TURN over TLS.
- UDP `49160-49200` for relay media, or use a larger range for more concurrent calls.

Use HTTPS/WSS for the AnonChat app when deploying outside localhost.

## coturn

Copy `ops/coturn/turnserver.conf.example` to your server's coturn config path and replace:

- `turn.example.com`
- `203.0.113.10`
- `static-auth-secret`
- certificate paths
- relay port range, if you expect more concurrent calls

TURN does not decrypt WebRTC media. It relays DTLS-SRTP packets between browsers. It can still see participant IP addresses, timing, and packet sizes.

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
        "turns:turn.example.com:5349?transport=tcp",
        "turn:turn.example.com:3478?transport=udp"
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

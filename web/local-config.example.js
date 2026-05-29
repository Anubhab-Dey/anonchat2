// Copy this file to web/local-config.js on the deployed server.
// Do not commit web/local-config.js. TURN credentials are visible to browsers,
// so production credentials should be short-lived.
window.ANONCHAT_CONFIG = {
  ...(window.ANONCHAT_CONFIG || {}),
  iceServers: [
    {
      urls: [
        "turns:turn.example.com:5349?transport=tcp",
        "turn:turn.example.com:3478?transport=udp"
      ],
      username: "replace-with-short-lived-username",
      credential: "replace-with-short-lived-credential"
    }
  ],
  callTransport: "p2p_first",
  relayFallbackEnabled: true,
  backendRelayFallbackEnabled: true,
  turnRequiredForFallback: true
};

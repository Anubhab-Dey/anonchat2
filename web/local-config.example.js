// Copy this file to web/local-config.js on the deployed server.
// Do not commit web/local-config.js. TURN credentials are fetched from the
// app server when ANONCHAT_TURN_SECRET is set.
window.ANONCHAT_CONFIG = {
  ...(window.ANONCHAT_CONFIG || {}),
  iceServers: [],
  turnCredentialUrl: "/turn-credentials.json",
  callTransport: "p2p_first",
  relayFallbackEnabled: true,
  backendRelayFallbackEnabled: true,
  turnRequiredForFallback: true
};

window.ANONCHAT_CONFIG = {
  // Keep this tracked default private by default. Deployment TURN credentials
  // belong in /local-config.js, which is intentionally ignored by git.
  iceServers: [],
  relayFallbackEnabled: true,
  backendRelayFallbackEnabled: true,
  turnRequiredForFallback: true,
  callTransport: "p2p_first",
  iceCandidatePoolSize: 2
};

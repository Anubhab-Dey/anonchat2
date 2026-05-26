window.ANONCHAT_CONFIG = {
  // Add trusted first-party STUN/TURN servers here at deployment time.
  // Example:
  // iceServers: [{ urls: ["turns:turn.example.com:5349"], username: "...", credential: "..." }]
  iceServers: [],
  relayFallbackEnabled: true,
  turnRequiredForFallback: true,
  iceCandidatePoolSize: 2
};

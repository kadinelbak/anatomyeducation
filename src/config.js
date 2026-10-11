// Endpoints for analytics events and email signups. tools/serve.py implements
// both locally; point them elsewhere (or set to "" to disable) when hosting
// the page on a static host.
export const CONFIG = {
  // The model: a .glb, or a .txt holding the same bytes base64-encoded.
  modelUrl: "assets/model/arm.glb",
  eventsUrl: "api/event",
  signupUrl: "api/signup",
};

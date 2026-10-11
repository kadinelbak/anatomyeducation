// Endpoints for analytics events and email signups. tools/serve.py implements
// both locally; point them elsewhere (or set to "" to disable) when hosting
// the page on a static host.
export const CONFIG = {
  eventsUrl: "api/event",
  signupUrl: "api/signup",
};

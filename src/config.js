// Endpoints for analytics events and email signups. tools/serve.py implements
// both locally; point them elsewhere (or set to "" to disable) when hosting
// the page on a static host.
export const CONFIG = {
  // The 3D models, keyed by the "model" a question bank names. A url is a
  // .glb, or a .txt holding the same bytes base64-encoded. The first is the default.
  models: {
    "upper-limb": { title: "Upper limb", modelUrl: "assets/model/arm.glb", structuresUrl: "assets/model/structures.json" },
    "lower-limb": { title: "Lower limb", modelUrl: "assets/model/lower-limb.glb", structuresUrl: "assets/model/lower-limb.structures.json" },
  },
  eventsUrl: "api/event",
  signupUrl: "api/signup",
  // The PRD requires clinician approval before public launch. Set this to
  // false to hide every question whose review.status is not "approved".
  includeDraftQuestions: true,
};

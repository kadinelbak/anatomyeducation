// Endpoints for analytics events and email signups. tools/serve.py implements
// both locally; point them elsewhere (or set to "" to disable) when hosting
// the page on a static host.
export const CONFIG = {
  // The 3D models, keyed by the "model" a question bank names. A url is a
  // .glb, or a .txt holding the same bytes base64-encoded. The first is the default.
  models: {
    "upper-limb": { title: "Upper limb", modelUrl: "assets/model/arm.glb", structuresUrl: "assets/model/structures.json" },
    "lower-limb": { title: "Lower limb", modelUrl: "assets/model/lower-limb.glb", structuresUrl: "assets/model/lower-limb.structures.json" },
    "trunk": { title: "Trunk", modelUrl: "assets/model/trunk.glb", structuresUrl: "assets/model/trunk.structures.json" },
    "neck": { title: "Neck", modelUrl: "assets/model/neck.glb", structuresUrl: "assets/model/neck.structures.json" },
    "head": { title: "Head", modelUrl: "assets/model/head.glb", structuresUrl: "assets/model/head.structures.json" },
  },
  // On a host that serves only text files (the hosted copy), the study files
  // are fetched as their base64 ".b64.txt" copies straight away.
  textAssets: false,
  // Slide tiles as one JSON bundle per pyramid level (tools/bundle_tiles.py) instead of one file per tile.
  tileBundles: false,
  // Optional JSON copy of each event for tools/serve.py and tools/report.py (local only; "" to
  // disable). Counts always go to GoatCounter when its script tag is on the page (see index.html).
  eventsUrl: "api/event",
  // Kit (kit.com) modal signup form. When set, "Get 50 more questions" opens this form and
  // signupUrl is unused. Set to "" to fall back to the built-in dialog that posts to signupUrl.
  kitFormUid: "0580fa41c5",
  kitFormUrl: "https://kadin-el-bakkouri.kit.com/0580fa41c5",
  signupUrl: "api/signup",
  // Shows the "Get 50 more questions" button on the results card.
  signupEnabled: true,
  // The PRD requires clinician approval before public launch. Set this to
  // false to hide every question whose review.status is not "approved".
  includeDraftQuestions: true,
};

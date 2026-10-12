// Question bank: loads the JSON records and drops drafts when the config asks.
import { CONFIG } from "./config.js";

const RENDERERS = ["mesh", "volume", "xray", "ultrasound"];

export async function loadBanks(urls) {
  const files = await Promise.all(urls.map((url) => fetch(url).then((r) => {
    if (!r.ok) throw new Error(`bank ${url} ${r.status}`);
    return r.json();
  })));
  // A bank file names the 3D model its mesh questions are asked on ("model",
  // a key of CONFIG.models); records may override it. The first model is the default.
  const defaultModel = Object.keys(CONFIG.models)[0];
  const questions = files
    .flatMap((data) => data.questions.map((q) => {
      const renderer = q.renderer || "mesh";
      if (!RENDERERS.includes(renderer)) throw new Error(`question ${q.id}: unknown renderer ${renderer}`);
      if (renderer !== "mesh" && !q.study) throw new Error(`question ${q.id}: ${renderer} question needs a study`);
      return renderer === "mesh" ? { ...q, renderer, model: q.model || data.model || defaultModel } : { ...q, renderer };
    }))
    .filter((q) => CONFIG.includeDraftQuestions || q.review?.status === "approved");
  return { questions, byId: new Map(questions.map((q) => [q.id, q])) };
}

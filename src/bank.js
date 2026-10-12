// Question bank: loads the JSON records and drops drafts when the config asks.
import { CONFIG } from "./config.js";

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
      return renderer === "mesh" ? { ...q, renderer, model: q.model || data.model || defaultModel } : { ...q, renderer };
    }))
    .filter((q) => CONFIG.includeDraftQuestions || q.review?.status === "approved");
  return { questions, byId: new Map(questions.map((q) => [q.id, q])) };
}

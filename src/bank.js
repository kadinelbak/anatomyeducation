// Question bank: loads the JSON records and drops drafts when the config asks.
import { CONFIG } from "./config.js";

export async function loadBanks(urls) {
  const files = await Promise.all(urls.map((url) => fetch(url).then((r) => {
    if (!r.ok) throw new Error(`bank ${url} ${r.status}`);
    return r.json();
  })));
  const questions = files
    .flatMap((data) => data.questions)
    .filter((q) => CONFIG.includeDraftQuestions || q.review?.status === "approved")
    .map((q) => (q.renderer ? q : { ...q, renderer: "mesh" }));
  return { questions, byId: new Map(questions.map((q) => [q.id, q])) };
}

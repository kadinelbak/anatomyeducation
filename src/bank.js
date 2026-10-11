// Question bank: loads the JSON records and drops drafts when the config asks.
import { CONFIG } from "./config.js";

export async function loadBank(url) {
  const data = await fetch(url).then((r) => {
    if (!r.ok) throw new Error(`bank ${r.status}`);
    return r.json();
  });
  const questions = data.questions.filter((q) => CONFIG.includeDraftQuestions || q.review?.status === "approved");
  return { questions, byId: new Map(questions.map((q) => [q.id, q])) };
}

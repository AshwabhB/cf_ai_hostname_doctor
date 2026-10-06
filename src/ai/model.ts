import type { LanguageModel } from "ai";
import { createWorkersAI } from "workers-ai-provider";
import { MODEL_ID } from "../config/model";
import { withDedupedStreams } from "./dedupe-stream";

// The single place a Workers AI model is created. Tests spy on `create` to prove
// that rejected input never reaches the model.
export const modelFactory = {
  create(ai: Ai, sessionAffinity?: string): LanguageModel {
    const workersai = createWorkersAI({ binding: withDedupedStreams(ai) });
    return workersai(MODEL_ID, { sessionAffinity });
  }
};

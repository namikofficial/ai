import type {
  RetrievalExplainInput,
  RetrievalExplainOutput,
} from "../../../packages/db/src/retrieval-explain.ts";
import { runRetrievalExplain } from "../../../packages/db/src/retrieval-explain.ts";

export type ExplainInput = RetrievalExplainInput;
export type ExplainOutput = RetrievalExplainOutput;
export const runExplainWithStore = runRetrievalExplain;

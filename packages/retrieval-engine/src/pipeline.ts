import type {
  MemoryEntryRecord,
  MemoryScope,
  ProjectRuleRecord,
  RetrievalChunk,
  RetrievalDepth,
  RetrievalFeedbackRecord,
  RetrievalIntentKind,
  RetrievalMissRecord,
  RetrievalMode,
} from "../../shared/src/index.ts";

export interface RetrievalPipelineSource {
  searchChunks(projectId: string, query: string, options: { limit: number }): RetrievalChunk[];
  searchChunksWithVector?: (
    projectId: string,
    query: string,
    queryVector: number[],
    options: { limit: number }
  ) => RetrievalChunk[];
  retrieval: {
    listQueriesForProject(projectId: string, limit: number): Array<{ id: string }>;
    listFeedback(retrievalQueryId: string, limit: number): RetrievalFeedbackRecord[];
    listMisses(retrievalQueryId: string): RetrievalMissRecord[];
    listPathBoosts(projectId: string, limit: number): Array<{ path: string; weight: number }>;
  };
  memory: {
    listEntries(
      projectId?: string | null,
      scope?: MemoryScope,
      limit?: number
    ): MemoryEntryRecord[];
    listFacts(
      projectId?: string | null,
      limit?: number
    ): Array<{ key: string; value: string; confidence: number; status?: string }>;
    listProjectRules(projectId?: string | null, limit?: number): ProjectRuleRecord[];
  };
  listProjectFiles(projectId: string, limit: number): Array<{ path: string }>;
}

export interface BuildRetrievalPipelineInputArgs {
  projectId: string;
  query: string;
  intent: RetrievalIntentKind;
  mode: RetrievalMode;
  depth: RetrievalDepth;
  ftsLimit: number;
  queryVector?: number[] | null;
}

export function buildRetrievalPipelineInput(
  source: RetrievalPipelineSource,
  args: BuildRetrievalPipelineInputArgs
): {
  query: string;
  intent: RetrievalIntentKind;
  mode: RetrievalMode;
  depth: RetrievalDepth;
  ftsChunks: RetrievalChunk[];
  vectorChunks: RetrievalChunk[];
  heuristicChunks: RetrievalChunk[];
  feedback: RetrievalFeedbackRecord[];
  feedbackChunkPaths: Map<string, string>;
  missRecords: RetrievalMissRecord[];
  pathBoosts: Map<string, number>;
  memoryEntries: MemoryEntryRecord[];
  facts: Array<{ key: string; value: string; confidence: number; status?: string }>;
  rules: ProjectRuleRecord[];
  priorSessionPaths: string[];
  budgetTokens: number;
  secretTerms: string[];
} {
  const ftsChunks = source.searchChunks(args.projectId, args.query, { limit: args.ftsLimit });
  const vectorChunks =
    args.queryVector && source.searchChunksWithVector
      ? source.searchChunksWithVector(args.projectId, args.query, args.queryVector, {
          limit: args.ftsLimit,
        })
      : [];
  const heuristicChunks = source.searchChunks(args.projectId, "", { limit: 4 });
  const queries = source.retrieval.listQueriesForProject(args.projectId, 200);
  const feedback: RetrievalFeedbackRecord[] = [];
  const misses: RetrievalMissRecord[] = [];
  for (const q of queries) {
    for (const fb of source.retrieval.listFeedback(q.id, 50)) feedback.push(fb);
    for (const miss of source.retrieval.listMisses(q.id)) misses.push(miss);
  }
  const memoryEntries = source.memory.listEntries(args.projectId, "project", 50);
  const facts = source.memory.listFacts(args.projectId, 50);
  const rules = source.memory.listProjectRules(args.projectId, 50);
  const recentSessionPaths = source.listProjectFiles(args.projectId, 25).map((file) => file.path);
  const feedbackChunkPaths = new Map<string, string>();
  for (const fb of feedback) {
    if (fb.chunkId) feedbackChunkPaths.set(fb.chunkId, fb.missedPath ?? "");
  }
  const pathBoosts = new Map<string, number>();
  for (const boost of source.retrieval.listPathBoosts(args.projectId, 200)) {
    pathBoosts.set(boost.path, boost.weight);
  }
  return {
    query: args.query,
    intent: args.intent,
    mode: args.mode,
    depth: args.depth,
    ftsChunks,
    vectorChunks,
    heuristicChunks,
    feedback,
    feedbackChunkPaths,
    missRecords: misses,
    pathBoosts,
    memoryEntries,
    facts,
    rules,
    priorSessionPaths: recentSessionPaths,
    budgetTokens: 4096,
    secretTerms: [],
  };
}

/**
 * Well-known model profile IDs used throughout the workbench.
 * Centralizing these avoids magic strings scattered across ask-engine,
 * dev-agent, model-runtime, and other packages.
 */

/** Query rewriting for retrieval (used in ask-engine and retrieval-engine). */
export const PROFILE_QUERY_REWRITE = "query-rewrite-local" as const;

/** Retrieval quality judgement / confidence scoring. */
export const PROFILE_RETRIEVAL_JUDGE = "retrieval-judge-local" as const;

/** Balanced planner for medium-risk tasks (dev-agent planning). */
export const PROFILE_PLANNER_BALANCED = "planner-balanced-local" as const;

/** Deep planner for high-risk / complex tasks. */
export const PROFILE_PLANNER_DEEP = "planner-deep-local" as const;

/** Fast planner for low-risk / simple tasks. */
export const PROFILE_PLANNER_FAST = "planner-fast-local" as const;

/** Repair/retry model for dev-agent repair loops. */
export const PROFILE_DEV_REPAIR = "dev-repair-local" as const;

/** Default answer synthesis profile. */
export const PROFILE_ANSWER = "answer-local" as const;

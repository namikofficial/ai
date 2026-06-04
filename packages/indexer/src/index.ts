export {
  chunkContent,
  hashContent,
  isFileSizeIndexable,
} from "./chunk.ts";
export type { Chunk, ChunkOptions } from "./chunk.ts";

export {
  DEFAULT_IGNORE_DIRS,
  TEXT_EXTENSIONS,
  inferLanguage,
  isProbablyTextFile,
  isReadableFile,
  safeReadText,
  walkFiles,
} from "./walk.ts";
export type { WalkOptions } from "./walk.ts";

export {
  collectionNameForEmbedding,
  defaultDimensionForProvider,
  defaultModelForProvider,
  readEmbeddingConfig,
} from "./config.ts";
export type { EmbeddingConfig, EmbeddingConfigInput } from "./config.ts";

export { indexProject } from "./indexer.ts";
export type {
  IndexEmbeddingBatcher,
  IndexFileResult,
  IndexProjectOptions,
  IndexProjectResult,
} from "./indexer.ts";

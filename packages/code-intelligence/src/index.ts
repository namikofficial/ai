import { createHash } from "node:crypto";
import type { CodeEdgeRecord, CodeSymbolRecord } from "../../shared/src/index.ts";

export type CodeSymbol = CodeSymbolRecord;
export type CodeEdge = CodeEdgeRecord;
export type CodeIntelligenceResult = ExtractCodeSymbolsResult;

export interface CodeChunkSpan {
  id: string;
  startLine: number;
  endLine: number;
  tokenCount: number;
}

export interface ExtractCodeSymbolsInput {
  projectId: string;
  fileId: string;
  path: string;
  language: string | null;
  content: string;
}

export interface ExtractCodeSymbolsResult {
  symbols: CodeSymbol[];
  edges: CodeEdge[];
  chunkLinks: Array<{ symbolId: string; chunkId: string; overlapLines: number }>;
  chunkMetadata: Map<
    string,
    Array<{
      id: string;
      kind: CodeSymbol["kind"];
      name: string;
      qualifiedName: string;
      signature: string | null;
    }>
  >;
  graphHints: {
    routeFiles: string[];
    middlewareFiles: string[];
    dbFiles: string[];
    authPaths: string[];
  };
}

export interface ProjectContextGraph {
  projectId: string;
  updatedAt: string;
  entrypoints: Array<{ path: string; symbolId: string; name: string; kind: CodeSymbol["kind"] }>;
  routeFiles: string[];
  middlewareFiles: string[];
  dbFiles: string[];
  authPaths: string[];
  packageBoundaries: string[];
  hotPaths: string[];
  notes: string[];
  symbolCount?: number;
}

const LANGUAGE_BY_EXTENSION: Record<string, string> = {
  ".ts": "typescript",
  ".tsx": "typescript",
  ".js": "javascript",
  ".jsx": "javascript",
  ".py": "python",
  ".rs": "rust",
  ".go": "go",
  ".sql": "sql",
};

function hashId(prefix: string, seed: string): string {
  const digest = createHash("sha1").update(seed).digest("hex").slice(0, 16);
  return `${prefix}_${digest}`;
}

function normalizeWhitespace(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function lines(content: string): string[] {
  return content.replace(/\r\n/g, "\n").split("\n");
}

function dedupe<T extends { id: string }>(items: T[]): T[] {
  const seen = new Set<string>();
  const result: T[] = [];
  for (const item of items) {
    if (seen.has(item.id)) continue;
    seen.add(item.id);
    result.push(item);
  }
  return result;
}

function dedupeCodeSymbols(symbols: CodeSymbol[]): CodeSymbol[] {
  const seen = new Set<string>();
  const result: CodeSymbol[] = [];
  for (const symbol of symbols) {
    const key = [
      symbol.projectId,
      symbol.fileId,
      symbol.path,
      symbol.kind,
      symbol.qualifiedName,
    ].join("|");
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(symbol);
  }
  return result;
}

function guessFileLanguage(path: string, fallback: string | null): string | null {
  const match = path.match(/\.[^.]+$/);
  if (match) {
    const mapped = LANGUAGE_BY_EXTENSION[match[0].toLowerCase()];
    if (mapped) return mapped;
  }
  return fallback;
}

function symbolId(
  input: ExtractCodeSymbolsInput,
  kind: CodeSymbol["kind"],
  name: string,
  startLine: number,
  endLine: number
): string {
  return hashId(
    "sym",
    `${input.projectId}|${input.fileId}|${input.path}|${kind}|${name}|${startLine}|${endLine}`
  );
}

function edgeId(
  input: ExtractCodeSymbolsInput,
  fromSymbolId: string,
  toSymbolId: string,
  kind: CodeEdge["kind"]
): string {
  return hashId("edge", `${input.projectId}|${fromSymbolId}|${toSymbolId}|${kind}`);
}

function openBraceCount(line: string): number {
  return (line.match(/{/g) ?? []).length - (line.match(/}/g) ?? []).length;
}

function findBlockEnd(
  sourceLines: string[],
  startIndex: number,
  language: string | null,
  startIndent = 0
): number {
  if (language === "python") {
    for (let index = startIndex + 1; index < sourceLines.length; index += 1) {
      const raw = sourceLines[index] ?? "";
      if (raw.trim().length === 0) continue;
      const indent = raw.match(/^\s*/)?.[0].length ?? 0;
      if (indent <= startIndent && !raw.trim().startsWith("#")) {
        return Math.max(startIndex, index - 1);
      }
    }
    return sourceLines.length - 1;
  }
  let balance = 0;
  let sawOpen = false;
  for (let index = startIndex; index < sourceLines.length; index += 1) {
    balance += openBraceCount(sourceLines[index] ?? "");
    if ((sourceLines[index] ?? "").includes("{")) {
      sawOpen = true;
    }
    if (sawOpen && balance <= 0) {
      return index;
    }
  }
  return Math.min(sourceLines.length - 1, startIndex + 1);
}

function makeSymbol(
  input: ExtractCodeSymbolsInput,
  kind: CodeSymbol["kind"],
  name: string,
  startLine: number,
  endLine: number,
  extra: Partial<CodeSymbol> & { metadata?: Record<string, unknown> } = {}
): CodeSymbol {
  const qualifiedName = extra.qualifiedName ?? `${input.path}#${name}`;
  return {
    id: extra.id ?? symbolId(input, kind, qualifiedName, startLine, endLine),
    projectId: input.projectId,
    fileId: input.fileId,
    path: input.path,
    language: extra.language ?? guessFileLanguage(input.path, input.language),
    kind,
    name,
    qualifiedName,
    startLine,
    endLine,
    signature: extra.signature ?? null,
    doc: extra.doc ?? null,
    metadata: extra.metadata ?? {},
  };
}

function collectDocComment(
  sourceLines: string[],
  startIndex: number,
  language: string | null
): string | null {
  const comments: string[] = [];
  let index = startIndex - 1;
  if (language === "python") {
    while (index >= 0) {
      const line = sourceLines[index] ?? "";
      if (line.trim().startsWith("#")) {
        comments.unshift(line.replace(/^\s*#\s?/, ""));
        index -= 1;
        continue;
      }
      if (line.trim().length === 0) {
        index -= 1;
        continue;
      }
      break;
    }
    return comments.length > 0 ? comments.join("\n") : null;
  }
  while (index >= 0) {
    const line = sourceLines[index] ?? "";
    const trimmed = line.trim();
    if (trimmed.startsWith("//")) {
      comments.unshift(trimmed.replace(/^\/\/\s?/, ""));
      index -= 1;
      continue;
    }
    if (trimmed.startsWith("*") || trimmed.startsWith("/*")) {
      comments.unshift(trimmed.replace(/^\*+\s?/, "").replace(/^\/\*\*?\s?/, ""));
      index -= 1;
      continue;
    }
    if (trimmed.length === 0) {
      index -= 1;
      continue;
    }
    break;
  }
  return comments.length > 0 ? comments.join("\n") : null;
}

function scanTsJs(input: ExtractCodeSymbolsInput): { symbols: CodeSymbol[]; edges: CodeEdge[] } {
  const sourceLines = lines(input.content);
  const symbols: CodeSymbol[] = [];
  const edges: CodeEdge[] = [];
  let classContext: { name: string; symbolId: string; endLine: number } | null = null;

  for (let index = 0; index < sourceLines.length; index += 1) {
    const line = sourceLines[index] ?? "";
    const trimmed = line.trim();
    if (!trimmed) continue;

    const importMatch = trimmed.match(/^import\s+(?:type\s+)?(.+?)\s+from\s+['"]([^'"]+)['"]/);
    if (importMatch) {
      const imported = normalizeWhitespace(importMatch[1] ?? "");
      const modulePath = importMatch[2] ?? "";
      symbols.push(
        makeSymbol(input, "import", modulePath, index + 1, index + 1, {
          signature: trimmed,
          metadata: { modulePath, imported, kind: "import" },
        })
      );
      continue;
    }

    const classMatch = trimmed.match(/^(?:export\s+)?(?:abstract\s+)?class\s+([A-Za-z_$][\w$]*)/);
    if (classMatch) {
      const name = classMatch[1] ?? "Class";
      const endLine = findBlockEnd(sourceLines, index, "typescript");
      const symbol = makeSymbol(input, "class", name, index + 1, endLine + 1, {
        signature: trimmed,
        doc: collectDocComment(sourceLines, index, "typescript"),
      });
      symbols.push(symbol);
      classContext = { name, symbolId: symbol.id, endLine: symbol.endLine };
      continue;
    }

    if (classContext && index + 1 <= classContext.endLine) {
      const methodMatch = trimmed.match(
        /^(?:public\s+|private\s+|protected\s+|static\s+|async\s+)*(?:readonly\s+)?([A-Za-z_$][\w$]*)\s*\(([^)]*)\)\s*(?::\s*[^{]+)?\{/
      );
      if (methodMatch) {
        const name = methodMatch[1] ?? "method";
        const endLine = findBlockEnd(sourceLines, index, "typescript");
        const symbol = makeSymbol(input, "method", name, index + 1, endLine + 1, {
          qualifiedName: `${classContext.name}.${name}`,
          signature: trimmed,
          doc: collectDocComment(sourceLines, index, "typescript"),
          metadata: { parentClass: classContext.name },
        });
        symbols.push(symbol);
        edges.push({
          id: edgeId(input, classContext.symbolId, symbol.id, "defines"),
          projectId: input.projectId,
          fromSymbolId: classContext.symbolId,
          toSymbolId: symbol.id,
          kind: "defines",
          confidence: 0.95,
          metadata: { relation: "class-member" },
        });
        continue;
      }
    }

    const functionMatch = trimmed.match(
      /^(?:export\s+)?(?:async\s+)?function\s+([A-Za-z_$][\w$]*)\s*\(([^)]*)\)/
    );
    if (functionMatch) {
      const name = functionMatch[1] ?? "function";
      const endLine = findBlockEnd(sourceLines, index, "typescript");
      const symbol = makeSymbol(input, "function", name, index + 1, endLine + 1, {
        signature: trimmed,
        doc: collectDocComment(sourceLines, index, "typescript"),
      });
      symbols.push(symbol);
      continue;
    }

    const arrowMatch = trimmed.match(
      /^(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?(?:\(([^)]*)\)|([A-Za-z_$][\w$]*))\s*=>/
    );
    if (arrowMatch) {
      const name = arrowMatch[1] ?? "constant";
      const endLine = findBlockEnd(sourceLines, index, "typescript");
      const kind: CodeSymbol["kind"] = /middleware/i.test(name)
        ? "middleware"
        : /route/i.test(name) || /^(app|router)\./i.test(name)
          ? "route"
          : "constant";
      const symbol = makeSymbol(input, kind, name, index + 1, endLine + 1, {
        signature: trimmed,
        doc: collectDocComment(sourceLines, index, "typescript"),
      });
      symbols.push(symbol);
      continue;
    }

    const constantMatch = trimmed.match(
      /^(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=/
    );
    if (constantMatch) {
      const name = constantMatch[1] ?? "constant";
      symbols.push(
        makeSymbol(input, "constant", name, index + 1, index + 1, {
          signature: trimmed,
          doc: collectDocComment(sourceLines, index, "typescript"),
        })
      );
      continue;
    }

    const interfaceMatch = trimmed.match(/^(?:export\s+)?interface\s+([A-Za-z_$][\w$]*)/);
    if (interfaceMatch) {
      const name = interfaceMatch[1] ?? "interface";
      const endLine = findBlockEnd(sourceLines, index, "typescript");
      symbols.push(
        makeSymbol(input, "interface", name, index + 1, endLine + 1, {
          signature: trimmed,
          doc: collectDocComment(sourceLines, index, "typescript"),
        })
      );
      continue;
    }

    const typeMatch = trimmed.match(/^(?:export\s+)?type\s+([A-Za-z_$][\w$]*)\s*=/);
    if (typeMatch) {
      const name = typeMatch[1] ?? "type";
      const endLine = findBlockEnd(sourceLines, index, "typescript");
      symbols.push(
        makeSymbol(input, "type", name, index + 1, endLine + 1, {
          signature: trimmed,
          doc: collectDocComment(sourceLines, index, "typescript"),
        })
      );
      continue;
    }

    if (/(?:router|app)\.(get|post|put|patch|delete|use)\s*\(/i.test(trimmed)) {
      const verb =
        trimmed
          .match(/(?:router|app)\.(get|post|put|patch|delete|use)\s*\(/i)?.[1]
          ?.toUpperCase() ?? "USE";
      const routePath = trimmed.match(/['"`]([^'"`]+)['"`]/)?.[1] ?? trimmed;
      const kind: CodeSymbol["kind"] = verb === "USE" ? "middleware" : "route";
      symbols.push(
        makeSymbol(input, kind, `${verb} ${routePath}`, index + 1, index + 1, {
          signature: trimmed,
          metadata: { verb, routePath },
        })
      );
    }
  }

  return { symbols: dedupe(symbols), edges };
}

function scanPython(input: ExtractCodeSymbolsInput): { symbols: CodeSymbol[]; edges: CodeEdge[] } {
  const sourceLines = lines(input.content);
  const symbols: CodeSymbol[] = [];
  const edges: CodeEdge[] = [];
  let classContext: { name: string; symbolId: string; endLine: number } | null = null;

  for (let index = 0; index < sourceLines.length; index += 1) {
    const line = sourceLines[index] ?? "";
    const trimmed = line.trim();
    if (!trimmed) continue;
    const indent = line.match(/^\s*/)?.[0].length ?? 0;

    const fromImportMatch = trimmed.match(/^from\s+([.\w]+)\s+import\s+(.+)/);
    if (fromImportMatch) {
      const modulePath = fromImportMatch[1] ?? "";
      const imported = normalizeWhitespace(fromImportMatch[2] ?? "");
      symbols.push(
        makeSymbol(input, "import", modulePath, index + 1, index + 1, {
          signature: trimmed,
          metadata: { imported, modulePath },
        })
      );
      continue;
    }

    const importMatch = trimmed.match(/^import\s+(.+)/);
    if (importMatch) {
      const imported = normalizeWhitespace(importMatch[1] ?? "");
      symbols.push(
        makeSymbol(input, "import", imported, index + 1, index + 1, {
          signature: trimmed,
          metadata: { imported },
        })
      );
      continue;
    }

    const classMatch = trimmed.match(/^class\s+([A-Za-z_][\w]*)/);
    if (classMatch) {
      const name = classMatch[1] ?? "Class";
      const endLine = findBlockEnd(sourceLines, index, "python", indent);
      const symbol = makeSymbol(input, "class", name, index + 1, endLine + 1, {
        signature: trimmed,
        doc: collectDocComment(sourceLines, index, "python"),
      });
      symbols.push(symbol);
      classContext = { name, symbolId: symbol.id, endLine: symbol.endLine };
      continue;
    }

    if (classContext && index + 1 <= classContext.endLine) {
      const methodMatch = trimmed.match(/^def\s+([A-Za-z_][\w]*)\s*\(([^)]*)\)/);
      if (methodMatch) {
        const name = methodMatch[1] ?? "method";
        const endLine = findBlockEnd(sourceLines, index, "python", indent);
        const symbol = makeSymbol(input, "method", name, index + 1, endLine + 1, {
          qualifiedName: `${classContext.name}.${name}`,
          signature: trimmed,
          doc: collectDocComment(sourceLines, index, "python"),
          metadata: { parentClass: classContext.name },
        });
        symbols.push(symbol);
        edges.push({
          id: edgeId(input, classContext.symbolId, symbol.id, "defines"),
          projectId: input.projectId,
          fromSymbolId: classContext.symbolId,
          toSymbolId: symbol.id,
          kind: "defines",
          confidence: 0.95,
          metadata: { relation: "class-member" },
        });
        continue;
      }
    }

    const functionMatch = trimmed.match(/^def\s+([A-Za-z_][\w]*)\s*\(([^)]*)\)/);
    if (functionMatch) {
      const name = functionMatch[1] ?? "function";
      const endLine = findBlockEnd(sourceLines, index, "python", indent);
      symbols.push(
        makeSymbol(input, "function", name, index + 1, endLine + 1, {
          signature: trimmed,
          doc: collectDocComment(sourceLines, index, "python"),
        })
      );
      continue;
    }

    if (/^@(?:app|router)\.(get|post|put|patch|delete|route)\b/i.test(trimmed)) {
      const verb =
        trimmed
          .match(/^@(?:app|router)\.(get|post|put|patch|delete|route)\b/i)?.[1]
          ?.toUpperCase() ?? "ROUTE";
      symbols.push(
        makeSymbol(input, verb === "ROUTE" ? "route" : "route", `${verb}`, index + 1, index + 1, {
          signature: trimmed,
          metadata: { verb, decorator: trimmed },
        })
      );
    }
  }

  return { symbols: dedupe(symbols), edges };
}

function scanRust(input: ExtractCodeSymbolsInput): { symbols: CodeSymbol[]; edges: CodeEdge[] } {
  const sourceLines = lines(input.content);
  const symbols: CodeSymbol[] = [];
  const edges: CodeEdge[] = [];
  let implContext: { name: string; symbolId: string; endLine: number } | null = null;

  for (let index = 0; index < sourceLines.length; index += 1) {
    const line = sourceLines[index] ?? "";
    const trimmed = line.trim();
    if (!trimmed) continue;

    const useMatch = trimmed.match(/^use\s+(.+);/);
    if (useMatch) {
      symbols.push(
        makeSymbol(input, "import", useMatch[1] ?? "use", index + 1, index + 1, {
          signature: trimmed,
          metadata: { imported: useMatch[1] ?? "" },
        })
      );
      continue;
    }

    const fnMatch = trimmed.match(/^(?:pub\s+)?(?:async\s+)?fn\s+([A-Za-z_][\w]*)\s*\(([^)]*)\)/);
    if (fnMatch) {
      const name = fnMatch[1] ?? "function";
      const endLine = findBlockEnd(sourceLines, index, "rust");
      const kind: CodeSymbol["kind"] = implContext ? "method" : "function";
      const symbol = makeSymbol(input, kind, name, index + 1, endLine + 1, {
        qualifiedName: implContext ? `${implContext.name}::${name}` : `${input.path}::${name}`,
        signature: trimmed,
        doc: collectDocComment(sourceLines, index, "rust"),
        metadata: implContext ? { parentType: implContext.name } : {},
      });
      symbols.push(symbol);
      if (implContext) {
        edges.push({
          id: edgeId(input, implContext.symbolId, symbol.id, "defines"),
          projectId: input.projectId,
          fromSymbolId: implContext.symbolId,
          toSymbolId: symbol.id,
          kind: "defines",
          confidence: 0.9,
          metadata: { relation: "impl-member" },
        });
      }
      continue;
    }

    const implMatch = trimmed.match(/^impl(?:<[^>]+>)?\s+([A-Za-z_][\w]*)/);
    if (implMatch) {
      const name = implMatch[1] ?? "impl";
      const endLine = findBlockEnd(sourceLines, index, "rust");
      const symbol = makeSymbol(input, "class", name, index + 1, endLine + 1, {
        signature: trimmed,
        doc: collectDocComment(sourceLines, index, "rust"),
      });
      symbols.push(symbol);
      implContext = { name, symbolId: symbol.id, endLine: symbol.endLine };
      continue;
    }

    const itemMatch = trimmed.match(
      /^(?:pub\s+)?(struct|enum|trait|const|static|mod)\s+([A-Za-z_][\w]*)/
    );
    if (itemMatch) {
      const kindToken = itemMatch[1] ?? "mod";
      const name = itemMatch[2] ?? kindToken;
      const kind: CodeSymbol["kind"] =
        kindToken === "const" || kindToken === "static" ? "constant" : "class";
      const endLine = findBlockEnd(sourceLines, index, "rust");
      symbols.push(
        makeSymbol(input, kind, name, index + 1, endLine + 1, {
          signature: trimmed,
          doc: collectDocComment(sourceLines, index, "rust"),
        })
      );
    }
  }

  return { symbols: dedupe(symbols), edges };
}

function scanGo(input: ExtractCodeSymbolsInput): { symbols: CodeSymbol[]; edges: CodeEdge[] } {
  const sourceLines = lines(input.content);
  const symbols: CodeSymbol[] = [];
  const edges: CodeEdge[] = [];
  let currentType: { name: string; symbolId: string; endLine: number } | null = null;

  for (let index = 0; index < sourceLines.length; index += 1) {
    const line = sourceLines[index] ?? "";
    const trimmed = line.trim();
    if (!trimmed) continue;

    if (trimmed.startsWith("import ")) {
      symbols.push(
        makeSymbol(input, "import", trimmed, index + 1, index + 1, { signature: trimmed })
      );
      continue;
    }
    if (trimmed.startsWith("const ") || trimmed.startsWith("var ")) {
      const name = trimmed.match(/^(?:const|var)\s+([A-Za-z_][\w]*)/)?.[1] ?? "constant";
      symbols.push(
        makeSymbol(input, "constant", name, index + 1, index + 1, { signature: trimmed })
      );
      continue;
    }
    const typeMatch = trimmed.match(/^type\s+([A-Za-z_][\w]*)\s+(struct|interface)?/);
    if (typeMatch) {
      const name = typeMatch[1] ?? "Type";
      const endLine = findBlockEnd(sourceLines, index, "go");
      const symbol = makeSymbol(input, "class", name, index + 1, endLine + 1, {
        signature: trimmed,
        doc: collectDocComment(sourceLines, index, "go"),
      });
      symbols.push(symbol);
      currentType = { name, symbolId: symbol.id, endLine: symbol.endLine };
      continue;
    }
    const funcMatch = trimmed.match(/^func\s*(\([^)]*\)\s*)?([A-Za-z_][\w]*)\s*\(([^)]*)\)/);
    if (funcMatch) {
      const receiver = (funcMatch[1] ?? "").replace(/[()\s]/g, "");
      const name = funcMatch[2] ?? "function";
      const endLine = findBlockEnd(sourceLines, index, "go");
      const kind: CodeSymbol["kind"] = receiver || currentType ? "method" : "function";
      const symbol = makeSymbol(input, kind, name, index + 1, endLine + 1, {
        qualifiedName: receiver
          ? `${receiver}.${name}`
          : currentType
            ? `${currentType.name}.${name}`
            : `${input.path}#${name}`,
        signature: trimmed,
        doc: collectDocComment(sourceLines, index, "go"),
        metadata: receiver || currentType ? { receiver: receiver || currentType?.name } : {},
      });
      symbols.push(symbol);
      if (currentType) {
        edges.push({
          id: edgeId(input, currentType.symbolId, symbol.id, "defines"),
          projectId: input.projectId,
          fromSymbolId: currentType.symbolId,
          toSymbolId: symbol.id,
          kind: "defines",
          confidence: 0.9,
          metadata: { relation: "type-member" },
        });
      }
    }
  }

  return { symbols: dedupe(symbols), edges };
}

function scanSql(input: ExtractCodeSymbolsInput): { symbols: CodeSymbol[]; edges: CodeEdge[] } {
  const sourceLines = lines(input.content);
  const symbols: CodeSymbol[] = [];
  for (let index = 0; index < sourceLines.length; index += 1) {
    const line = sourceLines[index] ?? "";
    const trimmed = line.trim();
    if (!trimmed) continue;
    const match = trimmed.match(
      /^(create\s+(table|view|function|trigger|index|procedure|type)\s+(?:if\s+not\s+exists\s+)?([A-Za-z0-9_."`]+))/i
    );
    if (match) {
      const kindToken = (match[2] ?? "constant").toLowerCase();
      const name = (match[3] ?? "sql").replace(/["`]/g, "").split(".").pop() ?? "sql";
      const kind: CodeSymbol["kind"] =
        kindToken === "table" || kindToken === "view" || kindToken === "type"
          ? "class"
          : "function";
      symbols.push(
        makeSymbol(input, kind, name, index + 1, index + 1, {
          signature: trimmed,
          metadata: { statement: match[1] ?? trimmed, sqlKind: kindToken },
        })
      );
    }
  }
  return { symbols: dedupe(symbols), edges: [] };
}

function localFilePathVariants(path: string): string[] {
  const withoutExt = path.replace(/\.[^.]+$/, "");
  return [
    path,
    `${withoutExt}.ts`,
    `${withoutExt}.tsx`,
    `${withoutExt}.js`,
    `${withoutExt}.jsx`,
    `${withoutExt}.py`,
    `${withoutExt}.rs`,
    `${withoutExt}.go`,
    `${withoutExt}.sql`,
    `${withoutExt}/index.ts`,
    `${withoutExt}/index.tsx`,
    `${withoutExt}/index.js`,
    `${withoutExt}/index.jsx`,
  ];
}

export function resolveLocalReference(path: string, specifier: string): string | null {
  if (!specifier.startsWith(".")) return null;
  const base = path.replace(/[^/]+$/, "");
  const normalized = `${base}${specifier}`.replace(/\/\.\//g, "/");
  return (
    localFilePathVariants(normalized).find((candidate) => /\.[a-z0-9]+$/i.test(candidate)) ?? null
  );
}

export function extractCodeIntelligence(input: ExtractCodeSymbolsInput): CodeIntelligenceResult {
  const language = guessFileLanguage(input.path, input.language);
  let result: { symbols: CodeSymbol[]; edges: CodeEdge[] } = { symbols: [], edges: [] };
  switch (language) {
    case "typescript":
    case "javascript":
      result = scanTsJs({ ...input, language });
      break;
    case "python":
      result = scanPython({ ...input, language });
      break;
    case "rust":
      result = scanRust({ ...input, language });
      break;
    case "go":
      result = scanGo({ ...input, language });
      break;
    case "sql":
      result = scanSql({ ...input, language });
      break;
    default:
      result = { symbols: [], edges: [] };
      break;
  }

  result.symbols = dedupeCodeSymbols(result.symbols);

  const chunkMetadata = new Map<
    string,
    Array<{
      id: string;
      kind: CodeSymbol["kind"];
      name: string;
      qualifiedName: string;
      signature: string | null;
    }>
  >();
  const chunkLinks: Array<{ symbolId: string; chunkId: string; overlapLines: number }> = [];

  for (const symbol of result.symbols) {
    chunkMetadata.set(symbol.id, [
      {
        id: symbol.id,
        kind: symbol.kind,
        name: symbol.name,
        qualifiedName: symbol.qualifiedName,
        signature: symbol.signature,
      },
    ]);
  }

  const path = input.path.toLowerCase();
  const hasRouteSymbol = result.symbols.some((s) => s.kind === "route" || /route/i.test(s.name));
  const hasMiddlewareSymbol = result.symbols.some(
    (s) => s.kind === "middleware" || /middleware/i.test(s.name)
  );
  const hasDbSymbol =
    result.symbols.some((s) => s.kind === "class" && /db|repository|store/i.test(s.name)) ||
    path.endsWith(".sql");

  const graphHints = {
    routeFiles: hasRouteSymbol || /route|router|api|server|handler/i.test(path) ? [input.path] : [],
    middlewareFiles: hasMiddlewareSymbol || /middleware|auth|guard/i.test(path) ? [input.path] : [],
    dbFiles:
      hasDbSymbol || /db|migration|schema|sql|prisma|drizzle/i.test(path) ? [input.path] : [],
    authPaths: /auth|session|jwt|tenant|login/i.test(path) ? [input.path] : [],
  };

  return {
    symbols: result.symbols,
    edges: dedupe(result.edges),
    chunkLinks,
    chunkMetadata,
    graphHints,
  };
}

export function extractCodeSymbols(input: ExtractCodeSymbolsInput): CodeIntelligenceResult {
  return extractCodeIntelligence(input);
}

export function linkSymbolsToChunks(
  symbols: CodeSymbol[],
  chunks: CodeChunkSpan[]
): {
  links: Array<{ symbolId: string; chunkId: string; overlapLines: number }>;
  metadataByChunkId: Map<
    string,
    Array<{
      id: string;
      kind: CodeSymbol["kind"];
      name: string;
      qualifiedName: string;
      signature: string | null;
      confidence: number;
    }>
  >;
} {
  const links: Array<{ symbolId: string; chunkId: string; overlapLines: number }> = [];
  const metadataByChunkId = new Map<
    string,
    Array<{
      id: string;
      kind: CodeSymbol["kind"];
      name: string;
      qualifiedName: string;
      signature: string | null;
      confidence: number;
    }>
  >();
  for (const chunk of chunks) {
    const symbolMetadata: Array<{
      id: string;
      kind: CodeSymbol["kind"];
      name: string;
      qualifiedName: string;
      signature: string | null;
      confidence: number;
    }> = [];
    for (const symbol of symbols) {
      const overlapStart = Math.max(symbol.startLine, chunk.startLine);
      const overlapEnd = Math.min(symbol.endLine, chunk.endLine);
      const overlap = Math.max(0, overlapEnd - overlapStart + 1);
      if (overlap <= 0) continue;
      links.push({ symbolId: symbol.id, chunkId: chunk.id, overlapLines: overlap });
      symbolMetadata.push({
        id: symbol.id,
        kind: symbol.kind,
        name: symbol.name,
        qualifiedName: symbol.qualifiedName,
        signature: symbol.signature,
        confidence: 0.9,
      });
    }
    if (symbolMetadata.length > 0) {
      metadataByChunkId.set(chunk.id, symbolMetadata);
    }
  }
  return { links, metadataByChunkId };
}

export function buildProjectContextGraph(input: {
  projectId: string;
  symbols: CodeSymbol[];
  paths: string[];
  updatedAt?: string;
}): ProjectContextGraph {
  const updatedAt = input.updatedAt ?? new Date().toISOString();
  const uniquePaths = Array.from(new Set(input.paths));
  const routeFiles = uniquePaths.filter((path) => /route|router|api|server|handler/i.test(path));
  const middlewareFiles = uniquePaths.filter((path) => /middleware|auth|guard/i.test(path));
  const dbFiles = uniquePaths.filter((path) =>
    /db|migration|schema|sql|prisma|drizzle/i.test(path)
  );
  const authPaths = uniquePaths.filter((path) => /auth|session|jwt|tenant|login/i.test(path));
  const packageBoundaries = uniquePaths
    .map((path) => path.split("/").slice(0, 2).join("/"))
    .filter((path) => path.startsWith("apps/") || path.startsWith("packages/"));
  const entrypoints = input.symbols
    .filter((symbol) => ["route", "middleware", "function", "class"].includes(symbol.kind))
    .filter(
      (symbol) =>
        /main|start|createApp|server|router|handler|auth|index/i.test(symbol.name) ||
        /route|api|auth|session/i.test(symbol.path)
    )
    .slice(0, 24)
    .map((symbol) => ({
      path: symbol.path,
      symbolId: symbol.id,
      name: symbol.qualifiedName,
      kind: symbol.kind,
    }));
  const hotPaths = dedupe(
    input.symbols
      .filter((symbol) =>
        /auth|session|tenant|index|model|retrieval|memory|config|db|route|middleware/i.test(
          `${symbol.path} ${symbol.name}`
        )
      )
      .map((symbol) => ({ id: symbol.path, path: symbol.path }))
  )
    .map((entry) => entry.path)
    .slice(0, 24);
  const notes = [
    routeFiles.length > 0 ? `route files: ${routeFiles.length}` : "no obvious route files",
    middlewareFiles.length > 0
      ? `middleware files: ${middlewareFiles.length}`
      : "no obvious middleware files",
    dbFiles.length > 0 ? `db/migration files: ${dbFiles.length}` : "no obvious db files",
  ];
  return {
    projectId: input.projectId,
    updatedAt,
    entrypoints,
    routeFiles,
    middlewareFiles,
    dbFiles,
    authPaths,
    packageBoundaries,
    hotPaths,
    notes,
    symbolCount: input.symbols.length,
  };
}

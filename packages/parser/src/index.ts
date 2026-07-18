// Structural parser for the workbench.
//
// This is the AST layer that the indexer, the code-intelligence
// graph, and the small-model tool calls all read from. It is
// intentionally narrower than a full TypeScript compiler: we only
// surface the structural facts we need (functions, classes,
// interfaces, methods, imports, exports) and a stable schema that
// downstream code can rely on.
//
// Languages:
//   * TypeScript, TSX, JavaScript, JSX - parsed with acorn +
//     acorn-typescript. TypeScript syntax is accepted as input
//     even when the file extension is .ts.
//   * Python - structural extraction with a focused set of regex
//     patterns that match the common cases (def, class, import).
//     This is deliberately conservative; the goal is to make
//     python projects searchable and the dev-agent safer, not to
//     be a full Python compiler.
//   * Go, Rust, SQL - not parsed here. The code-intelligence
//     package keeps its regex fallback for these so the indexer
//     never blocks on a missing parser.
//
// The parseSource function is total: it never throws. Failures
// are returned as diagnostics so the indexer can still index the
// file (with a heuristic fallback) instead of skipping it.

import { Parser as AcornParser } from "acorn";
import { tsPlugin } from "acorn-typescript";

export type ParserLanguage = "typescript" | "javascript" | "python" | "unknown";

export interface ParserSymbol {
  kind: "function" | "class" | "method" | "arrow" | "const" | "interface" | "type" | "enum";
  name: string;
  qualifiedName: string;
  startLine: number;
  endLine: number;
  signature: string | null;
  exported: boolean;
  parent: string | null;
  modifiers: string[];
}

export interface ParserImport {
  source: string;
  specifiers: Array<{ name: string; alias: string | null; kind: "default" | "named" | "namespace" }>;
  startLine: number;
  endLine: number;
}

export interface ParserExport {
  kind: "named" | "default" | "re-export" | "type";
  names: string[];
  source: string | null;
  startLine: number;
  endLine: number;
}

export interface ParseDiagnostic {
  startLine: number;
  endLine: number;
  message: string;
  severity: "warning" | "error";
}

export interface ParseResult {
  language: ParserLanguage;
  symbols: ParserSymbol[];
  imports: ParserImport[];
  exports: ParserExport[];
  diagnostics: ParseDiagnostic[];
}

export interface ParseSourceInput {
  path: string;
  content: string;
  language?: string | null;
}

function detectLanguage(path: string, fallback: string | null | undefined): ParserLanguage {
  const lower = path.toLowerCase();
  if (lower.endsWith(".ts") || lower.endsWith(".tsx") || lower.endsWith(".mts") || lower.endsWith(".cts")) {
    return "typescript";
  }
  if (lower.endsWith(".js") || lower.endsWith(".jsx") || lower.endsWith(".mjs") || lower.endsWith(".cjs")) {
    return "javascript";
  }
  if (lower.endsWith(".py")) {
    return "python";
  }
  if (fallback === "typescript" || fallback === "javascript" || fallback === "python") {
    return fallback;
  }
  return "unknown";
}

function signatureForFunction(node: AcornNode): string | null {
  if (!node || node.id == null || node.id.name == null) return null;
  const params = (node.params ?? [])
    .map((param) => {
      if (param.type === "Identifier" && param.name) return param.name;
      if (param.type === "AssignmentPattern" && (param as unknown as { left: { name?: string } }).left.name) {
        return `${(param as unknown as { left: { name?: string } }).left.name}?`;
      }
      if (param.type === "RestElement" && (param as unknown as { argument: { name?: string } }).argument.name) {
        return `...${(param as unknown as { argument: { name?: string } }).argument.name}`;
      }
      return "?";
    })
    .join(", ");
  return `${node.id.name}(${params})`;
}

function location(node: { start?: number; end?: number; loc?: { start: { line: number }; end: { line: number } } }): {
  startLine: number;
  endLine: number;
} {
  if (node.loc) {
    return { startLine: node.loc.start.line, endLine: node.loc.end.line };
  }
  return { startLine: 0, endLine: 0 };
}

interface AcornNode {
  type: string;
  start?: number;
  end?: number;
  loc?: { start: { line: number }; end: { line: number } };
  name?: string;
  id?: { name?: string } | null;
  init?: AcornNode | null;
  params?: AcornNode[];
  body?: AcornNode;
  superClass?: AcornNode | null;
  sourceType?: string;
  source?: { value?: string };
  specifiers?: AcornNode[];
  declaration?: AcornNode;
  declarations?: AcornNode[];
  expression?: AcornNode;
  members?: AcornNode[];
  value?: AcornNode;
  key?: AcornNode;
  kind?: string;
  static?: boolean;
  abstract?: boolean;
  readonly?: boolean;
  async?: boolean;
  generator?: boolean;
  computed?: boolean;
  attributes?: AcornNode[];
  leadingComments?: AcornNode[];
  innerComments?: AcornNode[];
  trailingComments?: AcornNode[];
  argument?: AcornNode;
  arguments?: AcornNode[];
  callee?: AcornNode;
  test?: AcornNode;
  consequent?: AcornNode;
  alternate?: AcornNode;
  left?: AcornNode;
  right?: AcornNode;
  elements?: AcornNode[];
  properties?: AcornNode[];
  property?: AcornNode;
  imported?: { name?: string };
  local?: { name?: string };
  exported?: { name?: string };
  importKind?: string;
  exportKind?: string;
  namespace?: string;
  identifier?: { name?: string };
  [key: string]: unknown;
}

function parseTypeScriptOrJavaScript(
  content: string,
  language: "typescript" | "javascript"
): Omit<ParseResult, "language"> {
  const diagnostics: ParseDiagnostic[] = [];
  let ast: AcornNode | null = null;
  try {
    // acorn-typescript exports `tsPlugin` as a function that, when
    // called with no arguments, returns the actual acorn plugin.
    // acorn's `Parser.extend` expects the plugin itself, so we
    // invoke tsPlugin first and then pass the result.
    const plugin = (tsPlugin as unknown as (opts?: unknown) => unknown)();
    const extended = (
      AcornParser.extend as unknown as (...plugins: unknown[]) => {
        parse: (src: string, opts: unknown) => unknown;
      }
    )(plugin);
    ast = extended.parse(content, {
      ecmaVersion: "latest",
      sourceType: "module",
      locations: true,
      allowReturnOutsideFunction: true,
      allowAwaitOutsideFunction: true,
      allowImportExportEverywhere: true,
      allowHashBang: true,
    }) as unknown as AcornNode;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    diagnostics.push({
      startLine: 1,
      endLine: 1,
      message: `parse error: ${message.slice(0, 240)}`,
      severity: "error",
    });
    return { symbols: [], imports: [], exports: [], diagnostics };
  }
  if (!ast) {
    return { symbols: [], imports: [], exports: [], diagnostics };
  }
  const symbols: ParserSymbol[] = [];
  const imports: ParserImport[] = [];
  const exports: ParserExport[] = [];

  const classStack: string[] = [];

  function qualified(name: string, parent: string | null): string {
    if (parent) return `${parent}.${name}`;
    return name;
  }

  function modifiersOf(node: AcornNode): string[] {
    const mods: string[] = [];
    if (node.static) mods.push("static");
    if (node.abstract) mods.push("abstract");
    if (node.readonly) mods.push("readonly");
    if (node.async) mods.push("async");
    if (node.generator) mods.push("generator");
    return mods;
  }

  function signatureForMethod(node: AcornNode, className: string | null): string | null {
    const keyName =
      node.key?.name ?? (node.key?.type === "Literal" ? String((node.key as { value: unknown }).value) : null);
    if (!keyName) return null;
    const params =
      (node.value && "params" in node.value ? (node.value as { params?: AcornNode[] }).params : node.params) ?? [];
    const paramNames = params.map((param) => {
      if (param.type === "Identifier" && param.name) return param.name;
      return "?";
    });
    return className ? `${className}.${keyName}(${paramNames.join(", ")})` : `${keyName}(${paramNames.join(", ")})`;
  }

  function visit(node: AcornNode | null | undefined, parent: string | null): void {
    if (!node) return;
    switch (node.type) {
      case "FunctionDeclaration": {
        const name = node.id?.name ?? "<anonymous>";
        const loc = location(node);
        symbols.push({
          kind: "function",
          name,
          qualifiedName: qualified(name, parent),
          startLine: loc.startLine,
          endLine: loc.endLine,
          signature: signatureForFunction(node),
          exported: false,
          parent,
          modifiers: modifiersOf(node),
        });
        return;
      }
      case "VariableDeclarator": {
        const init = node.init;
        if (init && (init.type === "ArrowFunctionExpression" || init.type === "FunctionExpression")) {
          const name = node.id?.name ?? "<anonymous>";
          const loc = location(init);
          const signature = signatureForFunction(init as unknown as AcornNode);
          symbols.push({
            kind: "arrow",
            name,
            qualifiedName: qualified(name, parent),
            startLine: loc.startLine,
            endLine: loc.endLine,
            signature: signature ? signature.replace(/^\(/, `${name}(`).replace(/^\?\(/, `${name}(`) : name,
            exported: false,
            parent,
            modifiers: init.type === "ArrowFunctionExpression" && (init as { async?: boolean }).async ? ["async"] : [],
          });
        } else if (node.id?.name) {
          const loc = location(node);
          symbols.push({
            kind: "const",
            name: node.id.name,
            qualifiedName: qualified(node.id.name, parent),
            startLine: loc.startLine,
            endLine: loc.endLine,
            signature: null,
            exported: false,
            parent,
            modifiers: [],
          });
        }
        return;
      }
      case "ClassDeclaration": {
        const name = node.id?.name ?? "<anonymous>";
        const loc = location(node);
        const parentName = qualified(name, parent);
        const base = (node.superClass && (node.superClass as { name?: string }).name) || null;
        const mods = modifiersOf(node);
        if (base) mods.push(`extends ${base}`);
        symbols.push({
          kind: "class",
          name,
          qualifiedName: parentName,
          startLine: loc.startLine,
          endLine: loc.endLine,
          signature: base ? `class ${name} extends ${base}` : `class ${name}`,
          exported: false,
          parent,
          modifiers: mods,
        });
        classStack.push(parentName);
        for (const member of (node.body?.body ?? []) as AcornNode[]) {
          if (member.type === "MethodDefinition") {
            const methodName =
              member.key?.name ??
              (member.key?.type === "Literal" ? String((member.key as { value: unknown }).value) : null);
            if (methodName) {
              const loc2 = location(member);
              symbols.push({
                kind: "method",
                name: methodName,
                qualifiedName: qualified(methodName, parentName),
                startLine: loc2.startLine,
                endLine: loc2.endLine,
                signature: signatureForMethod(member, name),
                exported: false,
                parent: parentName,
                modifiers: modifiersOf(member),
              });
            }
          } else if (member.type === "PropertyDefinition") {
            const propName =
              member.key?.name ??
              (member.key?.type === "Literal" ? String((member.key as { value: unknown }).value) : null);
            if (propName) {
              const loc2 = location(member);
              symbols.push({
                kind: "const",
                name: propName,
                qualifiedName: qualified(propName, parentName),
                startLine: loc2.startLine,
                endLine: loc2.endLine,
                signature: null,
                exported: false,
                parent: parentName,
                modifiers: modifiersOf(member),
              });
            }
          }
        }
        classStack.pop();
        return;
      }
      case "TSInterfaceDeclaration": {
        const name = node.id?.name ?? "<anonymous>";
        const loc = location(node);
        symbols.push({
          kind: "interface",
          name,
          qualifiedName: qualified(name, parent),
          startLine: loc.startLine,
          endLine: loc.endLine,
          signature: `interface ${name}`,
          exported: false,
          parent,
          modifiers: [],
        });
        return;
      }
      case "TSTypeAliasDeclaration": {
        const name = node.id?.name ?? "<anonymous>";
        const loc = location(node);
        symbols.push({
          kind: "type",
          name,
          qualifiedName: qualified(name, parent),
          startLine: loc.startLine,
          endLine: loc.endLine,
          signature: `type ${name} = ...`,
          exported: false,
          parent,
          modifiers: [],
        });
        return;
      }
      case "TSEnumDeclaration": {
        const name = node.id?.name ?? "<anonymous>";
        const loc = location(node);
        symbols.push({
          kind: "enum",
          name,
          qualifiedName: qualified(name, parent),
          startLine: loc.startLine,
          endLine: loc.endLine,
          signature: `enum ${name}`,
          exported: false,
          parent,
          modifiers: [],
        });
        return;
      }
      case "ExportNamedDeclaration": {
        const decl = node.declaration;
        if (decl) {
          const declLoc = location(decl);
          if (
            decl.type === "FunctionDeclaration" ||
            decl.type === "ClassDeclaration" ||
            decl.type === "TSInterfaceDeclaration" ||
            decl.type === "TSTypeAliasDeclaration" ||
            decl.type === "TSEnumDeclaration"
          ) {
            visit(decl, parent);
            const last = symbols[symbols.length - 1];
            if (last) {
              symbols[symbols.length - 1] = { ...last, exported: true, endLine: declLoc.endLine };
            }
          } else if (decl.type === "VariableDeclaration") {
            const declarators = (decl.declarations ?? []) as AcornNode[];
            for (const d of declarators) {
              visit(d, parent);
            }
            for (const d of declarators) {
              if (d.id?.name) {
                const last = symbols[symbols.length - 1];
                if (last && last.name === d.id.name) {
                  symbols[symbols.length - 1] = { ...last, exported: true };
                }
              }
            }
          }
          if (node.specifiers && node.specifiers.length > 0) {
            exports.push({
              kind: "named",
              names: node.specifiers
                .map((spec) => (spec.local as { name?: string } | null)?.name ?? spec.exported?.name)
                .filter((name): name is string => typeof name === "string"),
              source: null,
              ...location(node),
            });
          }
        } else if (node.specifiers && node.specifiers.length > 0) {
          exports.push({
            kind: "named",
            names: node.specifiers
              .map((spec) => (spec.local as { name?: string } | null)?.name ?? spec.exported?.name)
              .filter((name): name is string => typeof name === "string"),
            source: (node.source as { value?: string } | null)?.value ?? null,
            ...location(node),
          });
        }
        return;
      }
      case "ExportDefaultDeclaration": {
        exports.push({
          kind: "default",
          names: ["default"],
          source: null,
          ...location(node),
        });
        if (node.declaration) {
          visit(node.declaration, parent);
        }
        return;
      }
      case "ExportAllDeclaration": {
        const source = (node.source as { value?: string } | null)?.value ?? null;
        exports.push({
          kind: "re-export",
          names: ["*"],
          source,
          ...location(node),
        });
        return;
      }
      case "ImportDeclaration": {
        const source = (node.source as { value?: string } | null)?.value ?? "";
        const specifiers: ParserImport["specifiers"] = [];
        for (const spec of node.specifiers ?? []) {
          if (spec.type === "ImportDefaultSpecifier") {
            specifiers.push({
              name: (spec.local as { name?: string } | null)?.name ?? "default",
              alias: null,
              kind: "default",
            });
          } else if (spec.type === "ImportSpecifier") {
            specifiers.push({
              name: (spec.imported as { name?: string } | null)?.name ?? "?",
              alias: (spec.local as { name?: string } | null)?.name ?? null,
              kind: "named",
            });
          } else if (spec.type === "ImportNamespaceSpecifier") {
            specifiers.push({
              name: (spec.local as { name?: string } | null)?.name ?? "*",
              alias: null,
              kind: "namespace",
            });
          }
        }
        imports.push({ source, specifiers, ...location(node) });
        return;
      }
      default: {
        // walk children
        for (const key of Object.keys(node)) {
          const value = (node as Record<string, unknown>)[key];
          if (Array.isArray(value)) {
            for (const child of value) {
              if (child && typeof child === "object" && "type" in (child as object)) {
                visit(child as AcornNode, parent);
              }
            }
          } else if (value && typeof value === "object" && "type" in (value as object)) {
            visit(value as AcornNode, parent);
          }
        }
        return;
      }
    }
  }

  for (const statement of (ast.body ?? []) as AcornNode[]) {
    visit(statement, null);
  }

  if (language === "typescript") {
    // We do not have full TS-aware diagnostics; flag any TS-specific
    // syntax we couldn't reduce.
    const body = (ast.body ?? []) as AcornNode[];
    if (body.length > 0 && symbols.length === 0) {
      diagnostics.push({
        startLine: 1,
        endLine: 1,
        message: "no TypeScript symbols recovered",
        severity: "warning",
      });
    }
  }

  return { symbols, imports, exports, diagnostics };
}

function parsePython(content: string): Omit<ParseResult, "language"> {
  const symbols: ParserSymbol[] = [];
  const imports: ParserImport[] = [];
  const diagnostics: ParseDiagnostic[] = [];
  const lines = content.split("\n");
  const classStack: string[] = [];
  const indentStack: number[] = [];

  function popClassStack(indent: number): void {
    while (indentStack.length > 0 && indentStack[indentStack.length - 1] >= indent) {
      indentStack.pop();
      classStack.pop();
    }
  }

  function pushClassStack(indent: number, name: string): void {
    classStack.push(name);
    indentStack.push(indent);
  }

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    const lineNo = i + 1;
    const defMatch = line.match(/^(\s*)(?:async\s+)?def\s+([A-Za-z_][A-Za-z0-9_]*)\s*\(([^)]*)\)\s*(?:->[^:]+)?:/);
    if (defMatch) {
      const indent = defMatch[1].length;
      const name = defMatch[2];
      const params = defMatch[3].trim();
      // Pop any class context that ended before this def's indent level.
      popClassStack(indent);
      const parent = classStack[classStack.length - 1] ?? null;
      const isMethod = parent != null;
      symbols.push({
        kind: isMethod ? "method" : "function",
        name,
        qualifiedName: parent ? `${parent}.${name}` : name,
        startLine: lineNo,
        endLine: lineNo,
        signature: `${name}(${params})`,
        exported: false,
        parent,
        modifiers: line.includes("async def") ? ["async"] : [],
      });
      continue;
    }
    const classMatch = line.match(/^(\s*)class\s+([A-Za-z_][A-Za-z0-9_]*)\s*(?:\(([^)]*)\))?\s*:/);
    if (classMatch) {
      const indent = classMatch[1].length;
      const name = classMatch[2];
      const base = classMatch[3];
      popClassStack(indent);
      pushClassStack(indent, name);
      symbols.push({
        kind: "class",
        name,
        qualifiedName: name,
        startLine: lineNo,
        endLine: lineNo,
        signature: base ? `class ${name}(${base})` : `class ${name}`,
        exported: false,
        parent: null,
        modifiers: base ? [`extends ${base}`] : [],
      });
      continue;
    }
    const importMatch = line.match(/^(\s*)(?:from\s+([\w.]+)\s+import\s+([^#]+)|import\s+([^#]+))/);
    if (importMatch) {
      const source = importMatch[2] ?? importMatch[4] ?? "";
      const spec = importMatch[3] ?? importMatch[4] ?? "";
      const names = spec
        .split(",")
        .map((s) => s.trim().split(/\s+as\s+/)[0])
        .filter(Boolean);
      imports.push({
        source: source.trim(),
        specifiers: names.map((name) => ({ name, alias: null, kind: "named" as const })),
        startLine: lineNo,
        endLine: lineNo,
      });
    }
  }
  return { symbols, imports, exports: [], diagnostics };
}

export function parseSource(input: ParseSourceInput): ParseResult {
  const language = detectLanguage(input.path, input.language);
  if (language === "typescript" || language === "javascript") {
    try {
      return { language, ...parseTypeScriptOrJavaScript(input.content, language) };
    } catch (error) {
      return {
        language,
        symbols: [],
        imports: [],
        exports: [],
        diagnostics: [
          {
            startLine: 1,
            endLine: 1,
            message: error instanceof Error ? error.message.slice(0, 240) : String(error),
            severity: "error",
          },
        ],
      };
    }
  }
  if (language === "python") {
    return { language, ...parsePython(input.content) };
  }
  return { language: "unknown", symbols: [], imports: [], exports: [], diagnostics: [] };
}

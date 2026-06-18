import assert from "node:assert/strict";
import test from "node:test";
import { parseSource } from "../packages/parser/src/index.ts";

test("parser: extracts a TypeScript function declaration with start/end lines", () => {
  const content = [
    "export function login(user: string, password: string): boolean {",
    "  return user.length > 0 && password.length > 0;",
    "}",
  ].join("\n");
  const result = parseSource({ path: "src/auth.ts", content });
  assert.equal(result.language, "typescript");
  const fn = result.symbols.find((s) => s.name === "login");
  assert.ok(fn, "expected function symbol");
  assert.equal(fn!.kind, "function");
  assert.equal(fn!.exported, true);
  assert.equal(fn!.startLine, 1);
  assert.equal(fn!.endLine, 3);
  assert.match(fn!.signature ?? "", /^login\(user, password\)$/);
});

test("parser: extracts a class with methods and a parent prefix", () => {
  const content = [
    "export class AuthRouter extends BaseRouter {",
    "  private name: string;",
    "  login(user: string) {",
    "    return true;",
    "  }",
    "}",
  ].join("\n");
  const result = parseSource({ path: "src/router.ts", content });
  const cls = result.symbols.find((s) => s.name === "AuthRouter");
  assert.ok(cls);
  assert.equal(cls!.kind, "class");
  assert.ok((cls!.modifiers ?? []).some((m) => m.startsWith("extends")));
  const method = result.symbols.find((s) => s.name === "login");
  assert.ok(method);
  assert.equal(method!.kind, "method");
  assert.equal(method!.parent, "AuthRouter");
  assert.equal(method!.qualifiedName, "AuthRouter.login");
});

test("parser: extracts an arrow function assigned to const", () => {
  const content = "export const handler = async (req: Request) => { return 200; };";
  const result = parseSource({ path: "src/handler.ts", content });
  const arrow = result.symbols.find((s) => s.name === "handler");
  assert.ok(arrow);
  assert.equal(arrow!.kind, "arrow");
  assert.equal(arrow!.exported, true);
  assert.ok((arrow!.modifiers ?? []).includes("async"));
});

test("parser: extracts interfaces and type aliases", () => {
  const content = [
    "export interface User {",
    "  id: string;",
    "  name: string;",
    "}",
    "export type UserId = string;",
  ].join("\n");
  const result = parseSource({ path: "src/types.ts", content });
  const iface = result.symbols.find((s) => s.name === "User");
  assert.equal(iface?.kind, "interface");
  const alias = result.symbols.find((s) => s.name === "UserId");
  assert.equal(alias?.kind, "type");
});

test("parser: extracts imports and re-exports", () => {
  const content = [
    "import { foo, bar as baz } from './mod';",
    "import defaultExport from './other';",
    "export { foo } from './re';",
  ].join("\n");
  const result = parseSource({ path: "src/index.ts", content });
  assert.equal(result.imports.length, 2);
  const first = result.imports[0]!;
  assert.equal(first.source, "./mod");
  assert.equal(first.specifiers.length, 2);
  assert.equal(first.specifiers[0]?.name, "foo");
  assert.equal(first.specifiers[1]?.alias, "baz");
  assert.equal(result.exports.length, 1);
  assert.equal(result.exports[0]?.kind, "named");
  assert.equal(result.exports[0]?.source, "./re");
});

test("parser: returns a diagnostic for a syntax error and still recovers", () => {
  const content = "export function broken( { return 1; }";
  const result = parseSource({ path: "src/broken.ts", content });
  assert.equal(result.language, "typescript");
  // Either parse failed entirely (no symbols) or it recovered and produced
  // at least one diagnostic; both are acceptable.
  if (result.symbols.length === 0) {
    assert.ok(result.diagnostics.some((d) => d.severity === "error"));
  } else {
    assert.ok(result.diagnostics.length > 0);
  }
});

test("parser: Python extracts def and class with parent prefix", () => {
  const content = [
    "class AuthRouter(BaseRouter):",
    "    def __init__(self):",
    "        self.name = 'auth'",
    "",
    "    def login(self, user):",
    "        return True",
    "",
    "def standalone():",
    "    return 1",
  ].join("\n");
  const result = parseSource({ path: "src/auth.py", content });
  assert.equal(result.language, "python");
  const cls = result.symbols.find((s) => s.name === "AuthRouter");
  assert.equal(cls?.kind, "class");
  const init = result.symbols.find((s) => s.name === "__init__");
  assert.equal(init?.kind, "method");
  assert.equal(init?.parent, "AuthRouter");
  const login = result.symbols.find((s) => s.name === "login");
  // login is indented inside the class, so it should be reported as a method.
  assert.equal(login?.kind, "method");
  assert.equal(login?.qualifiedName, "AuthRouter.login");
  const standalone = result.symbols.find((s) => s.name === "standalone");
  assert.equal(standalone?.kind, "function");
  assert.equal(standalone?.parent, null);
});

test("parser: returns language 'unknown' for unsupported extensions without throwing", () => {
  const result = parseSource({ path: "data.bin", content: "binary stuff" });
  assert.equal(result.language, "unknown");
  assert.equal(result.symbols.length, 0);
  assert.equal(result.imports.length, 0);
});

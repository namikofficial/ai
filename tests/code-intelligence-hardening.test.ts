import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { extractCodeIntelligence } from "../packages/code-intelligence/src/index.ts";
import { createStore, initializeStore } from "../packages/db/src/store.ts";

test("code-intelligence: TypeScript arrow functions and class methods", () => {
  const content = `
export const login = (user: string) => {
  return user;
};

export class AuthService {
  private config: any;

  constructor(config: any) {
    this.config = config;
  }

  async login(user: string) {
    return user;
  }

  static create() {
    return new AuthService({});
  }
}

const logout = () => {
  console.log('logout');
};
`;

  const result = extractCodeIntelligence({
    projectId: "p1",
    fileId: "f1",
    path: "src/auth.ts",
    language: "typescript",
    content,
  });

  const names = result.symbols.map((s) => s.name);
  assert.ok(names.includes("login"), "Should find exported arrow function");
  assert.ok(names.includes("AuthService"), "Should find class");
  assert.ok(names.includes("login"), "Should find class method");
  assert.ok(names.includes("create"), "Should find static class method");
  assert.ok(names.includes("constructor"), "Should find constructor");
});

test("code-intelligence: TypeScript route and middleware detection", () => {
  const content = `
import { Router } from 'express';
const router = Router();

router.get('/login', (req, res) => {
  res.send('login');
});

router.post('/register', authMiddleware, (req, res) => {
  res.send('register');
});

export const authMiddleware = (req, res, next) => {
  next();
};

export default router;
`;

  const result = extractCodeIntelligence({
    projectId: "p1",
    fileId: "f1",
    path: "src/routes.ts",
    language: "typescript",
    content,
  });

  assert.ok(result.graphHints.routeFiles.includes("src/routes.ts"));
  assert.ok(result.graphHints.middlewareFiles.includes("src/routes.ts"));
});

test("code-intelligence: Python class methods", () => {
  const content = `
class AuthService:
    def __init__(self, config):
        self.config = config

    def login(self, user):
        return user

    @staticmethod
    def create():
        return AuthService({})

def logout():
    pass
`;

  const result = extractCodeIntelligence({
    projectId: "p1",
    fileId: "f1",
    path: "src/auth.py",
    language: "python",
    content,
  });

  const names = result.symbols.map((s) => s.name);
  assert.ok(names.includes("AuthService"));
  assert.ok(names.includes("login"));
  assert.ok(names.includes("create"));
  assert.ok(names.includes("__init__"));
  assert.ok(names.includes("logout"));
});

test("code-intelligence: Rust impl and fn", () => {
  const content = `
struct AuthService {
    config: String,
}

impl AuthService {
    fn new(config: String) -> Self {
        AuthService { config }
    }

    pub fn login(&self, user: String) -> String {
        user
    }
}

fn logout() {
    println!("logout");
}
`;

  const result = extractCodeIntelligence({
    projectId: "p1",
    fileId: "f1",
    path: "src/auth.rs",
    language: "rust",
    content,
  });

  const names = result.symbols.map((s) => s.name);
  assert.ok(names.includes("AuthService"));
  assert.ok(names.includes("new"));
  assert.ok(names.includes("login"));
  assert.ok(names.includes("logout"));
});

test("code-intelligence: Go func", () => {
  const content = `
package auth

type AuthService struct {
    config string
}

func NewAuthService(config string) *AuthService {
    return &AuthService{config: config}
}

func (s *AuthService) Login(user string) string {
    return user
}

func Logout() {
    fmt.Println("logout")
}
`;

  const result = extractCodeIntelligence({
    projectId: "p1",
    fileId: "f1",
    path: "src/auth.go",
    language: "go",
    content,
  });

  const names = result.symbols.map((s) => s.name);
  assert.ok(names.includes("AuthService"));
  assert.ok(names.includes("NewAuthService"));
  assert.ok(names.includes("Login"));
  assert.ok(names.includes("Logout"));
});

test("code-intelligence: SQL CREATE TABLE", () => {
  const content = `
CREATE TABLE users (
    id UUID PRIMARY KEY,
    email TEXT UNIQUE NOT NULL,
    password_hash TEXT NOT NULL
);

CREATE INDEX idx_users_email ON users(email);

SELECT * FROM users;
`;

  const result = extractCodeIntelligence({
    projectId: "p1",
    fileId: "f1",
    path: "src/schema.sql",
    language: "sql",
    content,
  });

  const names = result.symbols.map((s) => s.name);
  assert.ok(names.includes("users"));
  assert.ok(result.symbols.some((s) => s.kind === "class" && s.name === "users"));
});

test("code-intelligence: handles huge file without crashing", () => {
  const content = "export const a = 1;\n".repeat(100000); // Very large file
  const result = extractCodeIntelligence({
    projectId: "p1",
    fileId: "f1",
    path: "src/huge.ts",
    language: "typescript",
    content,
  });

  assert.ok(result.symbols.length > 0);
});

test("code-intelligence: deduplicates symbols", () => {
  const content = `
export function login() {}
export function login() {} // duplicate in source (unlikely but possible)
`;

  const result = extractCodeIntelligence({
    projectId: "p1",
    fileId: "f1",
    path: "src/auth.ts",
    language: "typescript",
    content,
  });

  const logins = result.symbols.filter((s) => s.name === "login");
  assert.equal(logins.length, 1);
});

test("code-intelligence: indexing handles deleted files", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "ai-code-intel-del-"));
  const repo = join(workspace, "repo");
  await mkdir(join(repo, "src"), { recursive: true });
  await writeFile(
    join(repo, ".ai-workbench.json"),
    JSON.stringify({
      include: ["src/**"],
      codeIntelligence: {
        enabled: true,
      },
    })
  );
  await writeFile(join(repo, "src", "auth.ts"), "export function login() {}");

  const store = createStore(initializeStore(join(workspace, "ai.db")));
  const project = store.createProject({ path: repo, name: "repo" });
  await store.indexProject(project.id);

  let count = store.db
    .prepare("SELECT COUNT(*) as count FROM code_symbols WHERE project_id = ?")
    .get(project.id) as { count: number };
  assert.ok(count.count > 0);

  await rm(join(repo, "src", "auth.ts"));
  await store.indexProject(project.id);
  count = store.db
    .prepare("SELECT COUNT(*) as count FROM code_symbols WHERE project_id = ?")
    .get(project.id) as { count: number };
  assert.equal(count.count, 0);

  store.db.close();
  await rm(workspace, { recursive: true, force: true });
});

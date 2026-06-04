declare const process: {
  argv: string[];
  env: Record<string, string | undefined>;
  cwd(): string;
  uptime(): number;
  exit(code?: number): never;
  on(event: string, listener: (...args: any[]) => void): void;
};

declare const Buffer: {
  from(data: string | ArrayBuffer | Uint8Array): Uint8Array;
  concat(chunks: Uint8Array[]): Uint8Array;
};

declare module "node:crypto" {
  export function randomUUID(): string;
  export function createHash(algorithm: "sha256" | string): {
    update(data: string | Uint8Array): any;
    digest(encoding: "hex"): string;
  };
}

declare module "node:path" {
  export function basename(path: string, suffix?: string): string;
  export function dirname(path: string): string;
  export function extname(path: string): string;
  export function isAbsolute(path: string): boolean;
  export function join(...parts: string[]): string;
  export function normalize(path: string): string;
  export function resolve(...parts: string[]): string;
  export function relative(from: string, to: string): string;
}

declare module "node:os" {
  export function tmpdir(): string;
}

declare module "node:fs/promises" {
  export interface Dirent {
    name: string;
    isDirectory(): boolean;
    isFile(): boolean;
    isSymbolicLink(): boolean;
  }

  export function access(path: string): Promise<void>;
  export function mkdir(path: string, options?: { recursive?: boolean }): Promise<string | undefined>;
  export function mkdtemp(prefix: string): Promise<string>;
  export function readFile(
    path: string | URL,
    options?: { encoding?: BufferEncoding } | BufferEncoding
  ): Promise<string>;
  export function readdir(
    path: string,
    options?: { withFileTypes?: boolean }
  ): Promise<string[] | Dirent[]>;
  export function stat(path: string): Promise<{
    isDirectory(): boolean;
    isFile(): boolean;
    size: number;
    mtimeMs: number;
  }>;
  export function rm(path: string, options?: { recursive?: boolean; force?: boolean }): Promise<void>;
  export function writeFile(
    path: string,
    data: string | Uint8Array,
    options?: { encoding?: BufferEncoding }
  ): Promise<void>;
}

declare module "node:assert/strict" {
  const assert: {
    ok(value: unknown, message?: string): void;
    equal(actual: unknown, expected: unknown, message?: string): void;
    deepEqual(actual: unknown, expected: unknown, message?: string): void;
    notEqual(actual: unknown, expected: unknown, message?: string): void;
    match(actual: string, expected: RegExp, message?: string): void;
    throws(fn: () => unknown, expected?: RegExp | Error | Function, message?: string): void;
  };
  export default assert;
}

declare module "node:test" {
  export interface TestContext {
    pass(message?: string): void;
    skip(message?: string): void;
  }
  export default function test(name: string, fn: (t: TestContext) => void | Promise<void>): void;
  export function before(fn: () => void | Promise<void>): void;
  export function after(fn: () => void | Promise<void>): void;
}

declare module "node:fs" {
  export function readFileSync(
    path: string,
    options?: { encoding?: BufferEncoding } | BufferEncoding,
  ): string;
  export function writeFileSync(
    path: string,
    data: string | Uint8Array,
    options?: { encoding?: string }
  ): void;
  export function mkdirSync(path: string, options?: { recursive?: boolean }): void;
  export function rmSync(path: string, options?: { recursive?: boolean; force?: boolean }): void;
  export function existsSync(path: string): boolean;
}

declare module "node:child_process" {
  export interface ChildProcessLike {
    stdout: {
      setEncoding(encoding: BufferEncoding | "utf8"): void;
      on(event: "data", listener: (chunk: string | Uint8Array) => void): void;
    } | null;
    stderr: {
      setEncoding(encoding: BufferEncoding | "utf8"): void;
      on(event: "data", listener: (chunk: string | Uint8Array) => void): void;
    } | null;
    exitCode: number | null;
    kill(signal?: NodeJS.Signals | number | string): boolean;
    once(event: "exit", listener: (...args: any[]) => void): void;
  }

  export function spawn(command: string, args?: string[], options?: {
    cwd?: string;
    env?: Record<string, string | undefined>;
    stdio?: Array<"pipe" | "ignore" | "inherit">;
  }): ChildProcessLike;
}

declare module "node:http" {
  export type Handler = (req: any, res: any) => void | Promise<void>;
  export function createServer(handler: Handler): {
    listen(port: number, host?: string, callback?: () => void): any;
    close(callback?: () => void): any;
  };
}

declare module "node:sqlite" {
  export interface StatementSync {
    all(...params: unknown[]): any[];
    get(...params: unknown[]): any;
    run(...params: unknown[]): { changes: number; lastInsertRowid: number };
  }

  export class DatabaseSync {
    constructor(path: string, options?: { readOnly?: boolean });
    prepare(sql: string): StatementSync;
    exec(sql: string): void;
    close(): void;
  }
}

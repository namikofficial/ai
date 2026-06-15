import { Buffer as BufferCtor } from "node:buffer";
import type { NextFunction, Request, Response } from "express";

export function getRequestPath(request: Request): string {
  const url = new URL(request.url ?? "/", "http://127.0.0.1");
  return url.pathname;
}

export function getRequestUrl(request: Request): URL {
  return new URL(request.url ?? "/", "http://127.0.0.1");
}

export function getRequestMethod(request: Request): string {
  return String(request.method ?? "GET").toUpperCase();
}

export function isHtmlRequest(req: Request): boolean {
  const accept = String(req.headers?.accept ?? "");
  return (
    accept.includes("text/html") || (!accept.includes("application/json") && !accept.includes("text/event-stream"))
  );
}

export function toUrlEncodedBody(value: Record<string, unknown>): string {
  const params = new URLSearchParams();
  for (const [key, raw] of Object.entries(value)) {
    if (raw == null) continue;
    if (Array.isArray(raw)) {
      for (const item of raw) params.append(key, String(item));
    } else {
      params.set(key, String(raw));
    }
  }
  return params.toString();
}

export async function readJsonBody(request: Request): Promise<unknown> {
  const parsedBody = request.body;
  if (parsedBody == null || parsedBody === "") return {};
  if (parsedBody instanceof (BufferCtor as unknown as { new (...args: unknown[]): unknown })) {
    const text = (parsedBody as { toString(encoding: string): string }).toString("utf8").trim();
    return text.length > 0 ? JSON.parse(text) : {};
  }
  if (typeof parsedBody === "string") {
    const text = parsedBody.trim();
    return text.length > 0 ? JSON.parse(text) : {};
  }
  if (typeof parsedBody === "object") return parsedBody;

  let body = "";
  for await (const chunk of request) {
    body += typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk);
  }
  return body.trim().length === 0 ? {} : JSON.parse(body);
}

export async function readTextBody(request: Request): Promise<string> {
  const parsedBody = request.body;
  if (parsedBody == null) return "";
  if (parsedBody instanceof (BufferCtor as unknown as { new (...args: unknown[]): unknown })) {
    return (parsedBody as { toString(encoding: string): string }).toString("utf8");
  }
  if (typeof parsedBody === "string") return parsedBody;
  if (typeof parsedBody === "object") return toUrlEncodedBody(parsedBody as Record<string, unknown>);

  let body = "";
  for await (const chunk of request) {
    body += typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk);
  }
  return body;
}

export function safeParseList(value: string): string[] {
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === "string") : [];
  } catch {
    return [];
  }
}

export function safeParseJson(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

export function asyncRoute(
  handler: (request: Request, response: Response, next: NextFunction) => Promise<void> | void
): (request: Request, response: Response, next: NextFunction) => void {
  return (request, response, next) => {
    void Promise.resolve(handler(request, response, next)).catch(next);
  };
}

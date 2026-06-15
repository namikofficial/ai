import type { Response } from "express";

export interface JsonResponse {
  status: "ok" | "error";
  data?: unknown;
  error?: { message: string; code?: string };
}

export function json(status: "ok" | "error", data?: unknown, error?: { message: string; code?: string }): JsonResponse {
  return status === "ok" ? { status, data } : { status, error };
}

export function sendJson(res: Response, payload: JsonResponse, statusCode = 200): void {
  res.status(statusCode);
  res.set("content-type", "application/json; charset=utf-8");
  res.set("cache-control", "no-store");
  res.json(payload);
}

export function sendHtml(res: Response, html: string, statusCode = 200): void {
  res.writeHead(statusCode, {
    "content-type": "text/html; charset=utf-8",
    "cache-control": "no-store",
    connection: "close",
  });
  res.end(html);
}

export function sendText(res: Response, body: string, statusCode = 200): void {
  res.writeHead(statusCode, {
    "content-type": "text/plain; charset=utf-8",
    "cache-control": "no-store",
    connection: "close",
  });
  res.end(body);
}

export function redirect(res: Response, location: string): void {
  res.writeHead(303, { location, connection: "close" });
  res.end();
}


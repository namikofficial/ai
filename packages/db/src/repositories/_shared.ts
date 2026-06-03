import { createId } from "../../../shared/src/index.ts";

export function now(): string {
  return new Date().toISOString();
}

export function asString(value: unknown): string {
  return typeof value === "string" ? value : "";
}

export function asStringOrNull(value: unknown): string | null {
  return value == null ? null : asString(value);
}

export function asNumber(value: unknown): number {
  if (typeof value === "number") return value;
  if (typeof value === "string" && value.length > 0) return Number(value);
  return 0;
}

export function asNumberOrNull(value: unknown): number | null {
  if (value == null) return null;
  if (typeof value === "number") return value;
  if (typeof value === "string" && value.length > 0) return Number(value);
  return null;
}

export function asBool(value: unknown): boolean {
  return value === 1 || value === true || value === "1";
}

export function safeParseJson<T = unknown>(value: string): T {
  try {
    const parsed = JSON.parse(value);
    return parsed as T;
  } catch {
    return {} as T;
  }
}

export function safeParseJsonArray<T = string>(value: string): T[] {
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? (parsed as T[]) : [];
  } catch {
    return [];
  }
}

export function newId(prefix: string): string {
  return createId(prefix);
}

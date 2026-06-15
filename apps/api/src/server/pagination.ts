import type { Request } from "express";

export const DEFAULT_LIMIT = 50;
export const MAX_LIMIT = 100;

export interface PaginationParams {
  limit: number;
  cursor?: string;
  offset?: number;
}

export interface PaginatedResult<T> {
  data: T[];
  pagination: {
    limit: number;
    hasMore: boolean;
    nextCursor?: string;
  };
}

/**
 * Parse pagination params from query string.
 * Supports `limit`, `cursor`, and `offset` (offset takes precedence over cursor).
 * Limit is clamped to [1, MAX_LIMIT].
 */
export function parsePagination(req: Request, defaultLimit = DEFAULT_LIMIT): PaginationParams {
  const rawLimit = req.query.limit;
  const rawCursor = req.query.cursor;
  const rawOffset = req.query.offset;

  const limit = clampLimit(typeof rawLimit === "string" ? parseInt(rawLimit, 10) : NaN, defaultLimit);
  const cursor = typeof rawCursor === "string" ? rawCursor : undefined;
  const offset =
    typeof rawOffset === "string"
      ? Math.max(0, parseInt(rawOffset, 10) || 0)
      : typeof rawOffset === "number"
        ? Math.max(0, rawOffset)
        : undefined;

  return { limit, cursor, offset: offset ?? (cursor ? undefined : 0) };
}

/**
 * Clamp limit to [1, MAX_LIMIT], falling back to defaultLimit on invalid input.
 */
export function clampLimit(raw: number, defaultLimit = DEFAULT_LIMIT): number {
  if (!Number.isFinite(raw) || raw < 1) return defaultLimit;
  return Math.min(raw, MAX_LIMIT);
}

/**
 * Build paginated response keeping backward compatibility:
 * - If no pagination params requested (no cursor/offset), return plain array
 * - Otherwise return paginated envelope with data + pagination info
 */
export function buildPaginatedResponse<T>(
  data: T[],
  params: PaginationParams
): T[] | PaginatedResult<T> {
  const hasMore = data.length > params.limit;
  const trimmed = hasMore ? data.slice(0, params.limit) : data;

  // Backward compatibility: if using default offset (0) and no cursor, return plain array
  if ((params.offset === 0 || params.offset === undefined) && !params.cursor) {
    return trimmed;
  }

  // nextCursor is the id of the last item (caller should ensure items have id)
  const lastItem = hasMore && trimmed.length > 0 ? trimmed[trimmed.length - 1] : null;
  const nextCursor =
    lastItem && typeof lastItem === "object" && lastItem !== null && "id" in lastItem
      ? String((lastItem as { id: unknown }).id)
      : hasMore
        ? String(trimmed.length)
        : undefined;

  return {
    data: trimmed,
    pagination: {
      limit: params.limit,
      hasMore,
      nextCursor,
    },
  };
}

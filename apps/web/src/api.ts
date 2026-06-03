import { createApiClient } from "../../../packages/api-client/src/index.ts";

export const api = createApiClient({
  baseUrl: new URL("/api", window.location.origin).toString(),
});

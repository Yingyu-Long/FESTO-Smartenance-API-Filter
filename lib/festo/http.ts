import { FestoError, errorMessage, validateToken } from "./client.ts";
export const NO_STORE = {
  "Cache-Control": "no-store, max-age=0",
  Pragma: "no-cache",
  "X-Content-Type-Options": "nosniff",
};
export function checkRequest(request: Request) {
  if (!request.headers.get("content-type")?.startsWith("application/json"))
    throw new FestoError("The request format is invalid.", 400);
}
export async function readBody(request: Request) {
  checkRequest(request);
  // Read with a hard size limit rather than trusting Content-Length.
  const reader = request.body?.getReader();
  if (!reader) throw new FestoError("The request body is empty.", 400);
  let size = 0;
  let text = "";
  const decoder = new TextDecoder();
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.length;
    if (size > 2 * 1024 * 1024) {
      await reader.cancel();
      throw new FestoError("The request body is too large.", 413);
    }
    text += decoder.decode(value, { stream: true });
  }
  try {
    return JSON.parse(text + decoder.decode());
  } catch {
    throw new FestoError("The request body is invalid.", 400);
  }
}
export function tokenFrom(request: Request) {
  return validateToken(request.headers.get("Authorization"));
}
export function errorResponse(error: unknown) {
  return Response.json(
    { error: errorMessage(error) },
    {
      status: error instanceof FestoError ? error.status : 502,
      headers: NO_STORE,
    },
  );
}

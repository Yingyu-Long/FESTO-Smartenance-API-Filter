import { errorMessage, FestoError } from "./client.ts";
import type { Progress } from "./types.ts";

// Empty NDJSON lines keep long rate-limit waits alive through idle-timeout proxies.
export function createOperationStream<T extends object>(
  run: (emit: (event: Progress) => void, signal: AbortSignal) => Promise<T>,
  options: { signal?: AbortSignal; heartbeatMs?: number } = {},
) {
  const abort = new AbortController();
  const encoder = new TextEncoder();
  let closed = false;
  let timer: ReturnType<typeof setInterval> | undefined;
  let onAbort: () => void;
  const cleanup = () => {
    clearInterval(timer);
    options.signal?.removeEventListener("abort", onAbort);
  };
  return new ReadableStream<Uint8Array>({
    start(controller) {
      const close = () => {
        cleanup();
        if (!closed) {
          closed = true;
          controller.close();
        }
      };
      onAbort = () => {
        abort.abort(options.signal?.reason);
        close();
      };
      if (options.signal?.aborted) {
        onAbort();
        return;
      }
      options.signal?.addEventListener("abort", onAbort, { once: true });
      const emit = (event: Progress | { type: "complete" } & T | { type: "error"; message: string; status: number }) => {
        if (!closed) controller.enqueue(encoder.encode(JSON.stringify(event) + "\n"));
      };
      timer = setInterval(() => {
        if (!closed && (controller.desiredSize ?? 0) > 0)
          controller.enqueue(encoder.encode("\n"));
      }, options.heartbeatMs ?? 15000);
      void (async () => {
        try {
          const result = await run(emit, abort.signal);
          if (!abort.signal.aborted) emit({ type: "complete", ...result });
        } catch (error) {
          if (!abort.signal.aborted) emit({
            type: "error", message: errorMessage(error),
            status: error instanceof FestoError ? error.status : 502,
          });
        } finally {
          close();
        }
      })();
    },
    cancel() {
      closed = true;
      abort.abort();
      cleanup();
    },
  });
}
export const createExportStream = createOperationStream;

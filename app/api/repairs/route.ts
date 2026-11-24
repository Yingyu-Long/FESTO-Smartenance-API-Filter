import {
  FestoError,
} from '@/lib/festo/client';
import { collectCachedRepairs } from '@/lib/festo/cached-repairs';
import { validateFilters } from '@/lib/festo/shared';
import { NO_STORE, readBody, tokenFrom, errorResponse } from '@/lib/festo/http';
import { createExportStream } from '@/lib/festo/export-stream';
export async function POST(request: Request) {
  try {
    const body = await readBody(request);
    let filters;
    try {
      filters = validateFilters(body);
    } catch (e) {
      throw new FestoError((e as Error).message, 400);
    }
    const token = tokenFrom(request);
    const stream = createExportStream((emit, signal) =>
      collectCachedRepairs(token, filters, emit, signal),
      { signal: request.signal },
    );
    return new Response(stream, {
      headers: {
        ...NO_STORE,
        'Content-Type': 'application/x-ndjson; charset=utf-8',
        'X-Accel-Buffering': 'no',
      },
    });
  } catch (error) {
    return errorResponse(error);
  }
}

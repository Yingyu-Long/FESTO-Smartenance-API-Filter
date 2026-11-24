import { syncDatabase } from '@/lib/festo/cached-repairs';
import { createOperationStream } from '@/lib/festo/export-stream';
import { NO_STORE, readBody, tokenFrom, errorResponse } from '@/lib/festo/http';

export async function POST(request: Request) {
  try {
    await readBody(request);
    const token = tokenFrom(request);
    const stream = createOperationStream((emit, signal) => syncDatabase(token, emit, signal),
      { signal: request.signal });
    return new Response(stream, { headers: { ...NO_STORE,
      'Content-Type': 'application/x-ndjson; charset=utf-8', 'X-Accel-Buffering': 'no',
    } });
  } catch (error) { return errorResponse(error); }
}

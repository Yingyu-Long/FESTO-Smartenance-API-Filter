export async function readOperationResult<T>(response: Response, onProgress: (message: string) => void, onUnauthorized: () => void): Promise<T> {
  if (!response.ok) {
    const body = await response.json() as { error?: string };
    if (response.status === 401) onUnauthorized();
    throw new Error(body.error || 'Query failed.');
  }
  if (!response.body) throw new Error('The server did not return any query results.');
  const reader = response.body.getReader(), decoder = new TextDecoder();
  let buffer = '', result: T | undefined;
  function consume(line: string) {
    if (!line.trim()) return;
    const event = JSON.parse(line);
    if (event.type === 'error') {
      if (event.status === 401) onUnauthorized();
      throw new Error(event.message);
    }
    if (event.type === 'progress') onProgress(event.message);
    if (event.type === 'complete') result = event as T;
  }
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let nl: number;
      while ((nl = buffer.indexOf('\n')) >= 0) {
        consume(buffer.slice(0, nl));
        buffer = buffer.slice(nl + 1);
      }
    }
    buffer += decoder.decode();
    if (buffer.trim()) consume(buffer);
    if (!result) throw new Error('The operation did not finish. Please try again.');
    return result;
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

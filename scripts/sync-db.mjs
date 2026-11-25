import { runScheduledSyncWithRetries } from '../lib/festo/auto-sync.ts';
import { getIncidentStore } from '../lib/festo/database.ts';

const controller = new AbortController();
for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => controller.abort());
}

const store = getIncidentStore();
try {
  await runScheduledSyncWithRetries({ store, signal: controller.signal });
} finally {
  await store.close();
}

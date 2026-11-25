import { setTimeout as delay } from 'node:timers/promises';
import {
  MAX_TIMER_SLEEP_MS,
  nextScheduledRun,
  parseSyncSchedule,
  runScheduledSyncWithRetries,
  shouldRunCatchUp,
} from '../lib/festo/auto-sync.ts';
import { getIncidentStore } from '../lib/festo/database.ts';

const controller = new AbortController();
for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    console.log(`[auto-sync ${new Date().toISOString()}] Received ${sig}, shutting down scheduler…`);
    controller.abort();
  });
}

const log = (msg) => console.log(`[auto-sync ${new Date().toISOString()}] ${msg}`);

async function sleepUntil(target, signal) {
  while (!signal.aborted) {
    const remaining = target.getTime() - Date.now();
    if (remaining <= 0) return;
    await delay(Math.min(remaining, MAX_TIMER_SLEEP_MS), undefined, { signal });
  }
}

const schedule = parseSyncSchedule(process.env);
const store = getIncidentStore();

try {
  await store.initialize();
  if (!schedule.enabled) {
    log(
      schedule.hasCredentials
        ? 'Scheduled database sync is disabled (SYNC_ENABLED=false). Standing by.'
        : 'Scheduled database sync is idle: configure FESTO_SYNC_USERNAME and FESTO_SYNC_PASSWORD in .env to enable scheduled sync.',
    );
    await sleepUntil(new Date(8640000000000000), controller.signal).catch(() => {});
  } else {
    log(
      `Auto-sync scheduler active: day(s) [${schedule.daysOfMonth.join(', ')}] at ${schedule.timeUtc8} UTC+8.`,
    );
    const lastSucceededAt = await store.lastSucceededScheduledAt();
    if (shouldRunCatchUp(lastSucceededAt, new Date(), schedule)) {
      log(
        lastSucceededAt
          ? `Missed previous scheduled window (last succeeded at ${lastSucceededAt}); running catch-up sync now…`
          : 'No prior scheduled sync recorded; running initial database sync now…',
      );
      await runScheduledSyncWithRetries({ store, signal: controller.signal, log }).catch((err) => {
        if (!controller.signal.aborted) log(`Catch-up sync ended with error: ${err?.message ?? err}`);
      });
    }

    while (!controller.signal.aborted) {
      const next = nextScheduledRun(new Date(), schedule);
      log(`Next scheduled sync at ${next.toISOString()} (${schedule.timeUtc8} UTC+8).`);
      await sleepUntil(next, controller.signal);
      if (controller.signal.aborted) break;
      await runScheduledSyncWithRetries({ store, signal: controller.signal, log }).catch((err) => {
        if (!controller.signal.aborted) log(`Scheduled sync run ended with error: ${err?.message ?? err}`);
      });
    }
  }
} catch (error) {
  if (!controller.signal.aborted) {
    console.error(`[auto-sync ${new Date().toISOString()}] Fatal scheduler error:`, error);
    process.exitCode = 1;
  }
} finally {
  await store.close().catch(() => {});
}

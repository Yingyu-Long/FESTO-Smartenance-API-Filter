import { FestoClient, FestoError, collectRepairs } from './client.ts';
import { BulkExportUnsupported } from './bulk-export.ts';
import { accountKeyForVerifiedToken, getIncidentStore, type IncidentStore } from './database.ts';
import { isIncidentState, UUID } from './shared.ts';
import type { Filters, Incident, Machine, MachineIncidents, Progress, SyncResult } from './types.ts';

export function validateSnapshot(incidents: Incident[], machineId: string) {
  const seen = new Set<string>(), tasks = new Set<string>();
  for (const incident of incidents) {
    if (!incident || !UUID.test(incident.id) || seen.has(incident.id) ||
        incident.machineId !== machineId || (incident.type && incident.type !== 'Incident') ||
        !isIncidentState(incident.state) || incident.repairTasks === undefined ||
        (incident.repairTasks !== null && !Array.isArray(incident.repairTasks)))
      throw new FestoError('The incident details are invalid. The query stopped to avoid missing tasks.');
    seen.add(incident.id);
    for (const task of incident.repairTasks ?? []) {
      if (!task || !UUID.test(task.id) || tasks.has(task.id) ||
          typeof task.createdAt !== 'string' || !Number.isFinite(Date.parse(task.createdAt)) ||
          !/(Z|[+-]\d{2}:\d{2})$/i.test(task.createdAt))
        throw new FestoError('A repair task has an invalid ID or creation time and cannot be filtered reliably.');
      tasks.add(task.id);
    }
  }
}

// Reads a complete, unfiltered machine snapshot. Never persist only the rows
// matching the user's dates or status: later queries may need other records.
export class MachineLoader {
  private bulkAvailable = true;
  async load(client: FestoClient, machine: Machine, report: (message: string) => void): Promise<Omit<MachineIncidents, 'syncedAt'>> {
    client.throwIfAborted();
    if (this.bulkAvailable) {
      try {
        const incidents = await client.bulkIncidents(machine.id);
        validateSnapshot(incidents, machine.id);
        return { incidents, source: 'bulk' };
      } catch (error) {
        client.throwIfAborted();
        const serverFailure = error instanceof FestoError && [500, 502, 503, 504].includes(error.upstreamStatus ?? 0);
        if (!(error instanceof BulkExportUnsupported) &&
            !(error instanceof FestoError && [403, 404].includes(error.status)) && !serverFailure) throw error;
        if (error instanceof FestoError) this.bulkAvailable = false;
        report(serverFailure ? `Bulk export failed (${error.upstreamStatus}). Using the standard query.`
          : 'Bulk export unavailable for this machine. Using the standard query.');
      }
    }
    const incidents: Incident[] = [];
    for await (const page of client.pages<Incident>('/incidents', { machineId: machine.id }, 1000)) {
      for (let offset = 0; offset < page.length; offset += 3) {
        const batch = await Promise.all(page.slice(offset, offset + 3).map(async (log) => {
          if (log.machineId !== machine.id)
            throw new FestoError('Festo returned an incident for a different machine. The query was stopped.');
          if (log.type && log.type !== 'Incident') return null;
          const detail = await client.get(`/incidents/${encodeURIComponent(log.id)}`) as Incident;
          if (!detail || detail.id !== log.id || (detail.machineId && detail.machineId !== machine.id))
            throw new FestoError('The incident details are invalid. The query stopped to avoid missing tasks.');
          return { ...detail, machineId: machine.id, logNumber: detail.logNumber ?? detail.number ?? log.number };
        }));
        client.throwIfAborted();
        incidents.push(...batch.filter((i): i is NonNullable<typeof i> => i !== null));
        report(`Loading complete machine data: ${incidents.length} incidents read.`);
      }
    }
    validateSnapshot(incidents, machine.id);
    return { incidents, source: 'standard' };
  }
}

export async function readThroughMachine(
  store: IncidentStore, account: string, client: FestoClient, loader: MachineLoader, machine: Machine,
  refresh: boolean, report: (message: string) => void, signal?: AbortSignal,
): Promise<MachineIncidents> {
  signal?.throwIfAborted();
  client.throwIfAborted();
  if (!refresh) {
    const cached = await store.read(account, machine.id);
    if (cached) {
      validateSnapshot(cached.incidents, machine.id);
      report(`Reading database for ${machine.name || machine.id}…`);
      return { ...cached, source: 'database' };
    }
  }
  const revision = await store.revision();
  report(`Updating database for ${machine.name || machine.id}…`);
  const fresh = await loader.load(client, machine, report);
  signal?.throwIfAborted();
  client.throwIfAborted();
  await store.replace(account, machine, fresh.incidents, revision, signal);
  // Read the committed snapshot: a newer concurrent sync may have won.
  const saved = await store.read(account, machine.id);
  if (!saved) throw new FestoError('The database snapshot is incomplete. Please sync again.', 503);
  return { ...saved, source: fresh.source };
}

export async function collectCachedRepairs(
  token: string, filters: Filters, emit: (event: Progress) => void, signal: AbortSignal,
  options: { client?: FestoClient; store?: IncidentStore } = {},
) {
  const client = options.client ?? new FestoClient(token, { signal });
  try {
    emit({ type: 'progress', message: 'Loading machines…', scanned: 0, matched: 0 });
    // Validate token and current machine access on EVERY request, even cache hits.
    const machines = await client.machines();
    signal.throwIfAborted();
    const account = accountKeyForVerifiedToken(token);
    const store = options.store ?? getIncidentStore();
    const loader = new MachineLoader();
    const report = (message: string) => emit({ type: 'progress', message, scanned: 0, matched: 0 });
    return await collectRepairs(client, filters, emit, signal, { machines,
      read: (machine) => readThroughMachine(store, account, client, loader, machine, false, report, signal),
    });
  } catch (error) { client.cancel(); throw error; }
}

export async function syncDatabase(
  token: string, emit: (event: Progress) => void, signal: AbortSignal,
  options: { client?: FestoClient; store?: IncidentStore } = {},
): Promise<SyncResult> {
  const client = options.client ?? new FestoClient(token, { signal });
  let syncedMachines = 0, incidents = 0;
  const report = (message: string) => emit({ type: 'progress', message, scanned: incidents, matched: syncedMachines });
  client.onRateLimit = (seconds) => report(`Festo rate limit reached. Waiting at least ${seconds} seconds, then resuming automatically. You can cancel this query.`);
  try {
    report('Loading machines…');
    const machines = await client.machines();
    signal.throwIfAborted();
    const account = accountKeyForVerifiedToken(token);
    const store = options.store ?? getIncidentStore();
    const loader = new MachineLoader();
    // A complete machine is committed independently. Cancellation/failure keeps
    // earlier completed machines, while the failed machine keeps its old snapshot.
    for (const machine of machines) {
      const saved = await readThroughMachine(store, account, client, loader, machine, true, report, signal);
      incidents += saved.incidents.length;
      syncedMachines++;
      report(`Synced ${syncedMachines} of ${machines.length} machines · ${incidents} incidents.`);
    }
    signal.throwIfAborted();
    return { machines, syncedMachines, incidents, syncedAt: new Date().toISOString() };
  } catch (error) { client.cancel(); throw error; }
}

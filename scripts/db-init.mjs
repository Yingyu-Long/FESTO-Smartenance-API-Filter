import { getIncidentStore } from '../lib/festo/database.ts';
const store = getIncidentStore();
try {
  await store.initialize();
  console.log('PostgreSQL schema initialized.');
} finally { await store.close(); }

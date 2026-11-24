import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync, unlinkSync } from 'node:fs';
import { resolve, join } from 'node:path';
import pg from 'pg';
import { getIncidentStore } from '../lib/festo/database.ts';

const action = process.argv[2] ?? 'start';
if (!['start', 'stop', 'status'].includes(action)) throw new Error('Use start, stop or status.');
if (!process.env.DATABASE_URL) throw new Error('Configure DATABASE_URL in .env first.');
const url = new URL(process.env.DATABASE_URL);
if (!['127.0.0.1', 'localhost'].includes(url.hostname)) throw new Error('Local setup requires a loopback DATABASE_URL.');
const username = decodeURIComponent(url.username), password = decodeURIComponent(url.password);
const database = decodeURIComponent(url.pathname.slice(1)), port = Number(url.port || 5432);
if (!/^[a-z_][a-z0-9_]*$/.test(username) || !/^[a-z_][a-z0-9_]*$/.test(database) || !password || !Number.isInteger(port))
  throw new Error('Use a valid local database name, username, password and port in .env.');
const binaries = await import(`@embedded-postgres/${process.platform}-${process.arch}`);
const root = resolve('.local'), data = join(root, 'postgres');
mkdirSync(root, { recursive: true, mode: 0o700 });
function run(binary, args, allowFailure = false) {
  const result = spawnSync(binary, args, { encoding: 'utf8' });
  if (!allowFailure && result.status !== 0) {
    console.error(result.stdout || result.stderr || 'PostgreSQL command failed.');
    throw new Error('Local PostgreSQL command failed. Check .local/postgres.log.');
  }
  return result;
}
const status = () => run(binaries.pg_ctl, ['-D', data, 'status'], true);
if (action === 'status') {
  console.log(status().status === 0 ? 'Local PostgreSQL is running.' : 'Local PostgreSQL is stopped.');
} else if (action === 'stop') {
  if (status().status === 0) run(binaries.pg_ctl, ['-D', data, 'stop', '-m', 'fast', '-w']);
  console.log('Local PostgreSQL stopped. Data is preserved.');
} else {
  if (!existsSync(join(data, 'PG_VERSION'))) {
    const passwordFile = join(root, 'postgres-init-password');
    writeFileSync(passwordFile, password + '\n', { mode: 0o600 });
    try {
      run(binaries.initdb, ['-D', data, '-U', username, '--pwfile=' + passwordFile,
        '--auth=scram-sha-256', '--encoding=UTF8', '--locale=C']);
    } finally { unlinkSync(passwordFile); }
  }
  if (status().status !== 0) {
    run(binaries.pg_ctl, ['-D', data, '-l', join(root, 'postgres.log'), '-w',
      '-o', `-h 127.0.0.1 -p ${port} -c unix_socket_directories=''`, 'start']);
  }
  const adminUrl = new URL(url); adminUrl.pathname = '/postgres';
  const client = new pg.Client({ connectionString: adminUrl.toString(), connectionTimeoutMillis: 5000 });
  try {
    await client.connect();
    const existing = await client.query('SELECT 1 FROM pg_database WHERE datname = $1', [database]);
    if (!existing.rowCount) await client.query(`CREATE DATABASE "${database}" OWNER "${username}"`);
  } finally { await client.end(); }
  const store = getIncidentStore();
  try { await store.initialize(); } finally { await store.close(); }
  console.log(`Local PostgreSQL ready at 127.0.0.1:${port}; database: ${database}. Data: .local/postgres`);
}

// Thin client for running read-only ad-hoc SQL through Metabase's REST API,
// authenticated with a read-only API key (never a personal password).

function loadEnv() {
  try {
    process.loadEnvFile(new URL('../.env', import.meta.url));
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
  }
}

function getConfig() {
  loadEnv();
  const url = process.env.METABASE_URL;
  const apiKey = process.env.METABASE_API_KEY;
  if (!url || !apiKey) {
    throw new Error(
      'Missing METABASE_URL or METABASE_API_KEY.\n' +
      'Copy .env.example to .env and fill them in first.'
    );
  }
  return { url: url.replace(/\/$/, ''), apiKey, databaseId: process.env.METABASE_DATABASE_ID };
}

async function mbFetch(path, options = {}) {
  const { url, apiKey } = getConfig();
  const res = await fetch(url + path, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      ...options.headers,
    },
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`Metabase API ${res.status} on ${path}: ${body.slice(0, 500)}`);
  }
  return res.json();
}

export async function listDatabases() {
  const data = await mbFetch('/api/database');
  const dbs = Array.isArray(data) ? data : data.data;
  return dbs.filter((db) => !db.is_sample && !db.is_saved_questions);
}

export async function resolveDatabaseId() {
  const { databaseId } = getConfig();
  if (databaseId) return Number(databaseId);

  const dbs = await listDatabases();
  if (dbs.length === 1) return dbs[0].id;

  const postgresOnly = dbs.filter((db) => db.engine === 'postgres');
  if (postgresOnly.length === 1) return postgresOnly[0].id;

  const options = dbs.map((db) => `  ${db.id} — ${db.name} (${db.engine})`).join('\n');
  throw new Error(
    `Multiple databases found, set METABASE_DATABASE_ID in .env to one of:\n${options}`
  );
}

// Extra client-side guardrail on top of the read-only API key: this agent
// should never attempt a write, even if the key somehow had permission.
const WRITE_KEYWORDS = /\b(insert|update|delete|drop|alter|truncate|grant|revoke|create)\b/i;

export async function runSQL(sql, { databaseId } = {}) {
  if (WRITE_KEYWORDS.test(sql)) {
    throw new Error('Refusing to run a query that looks like a write: ' + sql.slice(0, 200));
  }

  const dbId = databaseId ?? (await resolveDatabaseId());
  const result = await mbFetch('/api/dataset', {
    method: 'POST',
    body: JSON.stringify({
      type: 'native',
      native: { query: sql },
      database: dbId,
    }),
  });

  if (result.error) {
    throw new Error('Query failed: ' + result.error);
  }

  const cols = result.data.cols.map((c) => c.name);
  return result.data.rows.map((row) => Object.fromEntries(cols.map((c, i) => [c, row[i]])));
}

#!/usr/bin/env node
// Usage:
//   node query.js                              -> list connected databases (find METABASE_DATABASE_ID)
//   node query.js "SELECT 1"                    -> run SQL, print as a table
//   node query.js --json "SELECT 1"              -> run SQL, print raw JSON rows

import { listDatabases, runSQL } from './src/metabase.js';

const args = process.argv.slice(2);
const jsonOutput = args.includes('--json');
const sql = args.filter((a) => a !== '--json').join(' ').trim();

try {
  if (!sql) {
    const dbs = await listDatabases();
    console.log('Connected databases (set METABASE_DATABASE_ID in .env if more than one):');
    for (const db of dbs) console.log(`  ${db.id} — ${db.name} (${db.engine})`);
    process.exit(0);
  }

  const rows = await runSQL(sql);
  if (jsonOutput) {
    console.log(JSON.stringify(rows, null, 2));
  } else {
    console.table(rows);
  }
} catch (err) {
  console.error(err.message);
  process.exit(1);
}

import { buildSystemPrompt } from './prompt.js';

const ANTHROPIC_API = 'https://api.anthropic.com/v1/messages';
const MAX_TOOL_ITERATIONS = 6;
const MAX_ROWS_RETURNED = 200;

// Client-side guardrail on top of the read-only Metabase key — this agent
// should never even attempt a write.
const WRITE_KEYWORDS = /\b(insert|update|delete|drop|alter|truncate|grant|revoke|create)\b/i;

const RUN_SQL_TOOL = {
  name: 'run_sql',
  description:
    "Run a single read-only PostgreSQL SELECT statement against the company's live database. The result is shown directly to the user as a table — you will NOT see the rows back, only whether it succeeded or the error text if it failed. Use the schema in your instructions to find table and column names first; write one complete query that fully answers the question, since you don't get a chance to inspect results and adjust.",
  input_schema: {
    type: 'object',
    properties: {
      sql: {
        type: 'string',
        description: 'A single read-only SQL SELECT statement (no writes).',
      },
    },
    required: ['sql'],
  },
};

// Resolved once per process, reused across requests.
let cachedDatabaseId = null;

async function resolveDatabaseId(env) {
  if (cachedDatabaseId) return cachedDatabaseId;

  const res = await fetch(`${env.METABASE_URL}/api/database`, {
    headers: { 'x-api-key': env.METABASE_API_KEY },
  });
  if (!res.ok) {
    throw new Error(`Metabase API ${res.status} on /api/database: ${(await res.text()).slice(0, 300)}`);
  }
  const data = await res.json();
  const dbs = (Array.isArray(data) ? data : data.data).filter(
    (db) => !db.is_sample && !db.is_saved_questions,
  );

  if (dbs.length === 1) {
    cachedDatabaseId = dbs[0].id;
  } else {
    const postgresOnly = dbs.filter((db) => db.engine === 'postgres');
    if (postgresOnly.length === 1) cachedDatabaseId = postgresOnly[0].id;
  }
  if (!cachedDatabaseId) {
    throw new Error('Could not resolve a single Metabase database automatically — set METABASE_DATABASE_ID.');
  }
  return cachedDatabaseId;
}

async function runSql(sql, env) {
  if (WRITE_KEYWORDS.test(sql)) {
    return { error: 'Refused: this looks like a write query. run_sql is read-only.' };
  }
  if (!env.METABASE_API_KEY) {
    return {
      error:
        "Metabase isn't connected yet — METABASE_API_KEY is not set. Tell the user you can't query live data until that's configured.",
    };
  }

  try {
    const databaseId = env.METABASE_DATABASE_ID || (await resolveDatabaseId(env));
    const res = await fetch(`${env.METABASE_URL}/api/dataset`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': env.METABASE_API_KEY,
      },
      body: JSON.stringify({ type: 'native', native: { query: sql }, database: databaseId }),
    });

    if (!res.ok) {
      return { error: `Metabase API ${res.status}: ${(await res.text()).slice(0, 500)}` };
    }
    const result = await res.json();
    if (result.error) {
      return { error: `Query failed: ${result.error}` };
    }

    const cols = result.data.cols.map((c) => c.name);
    const rows = result.data.rows.map((row) => Object.fromEntries(cols.map((c, i) => [c, row[i]])));
    const truncated = rows.length > MAX_ROWS_RETURNED;
    return {
      cols,
      rows: truncated ? rows.slice(0, MAX_ROWS_RETURNED) : rows,
      row_count: rows.length,
      truncated,
    };
  } catch (err) {
    return { error: String(err.message || err) };
  }
}

async function callClaude(env, messages, schema) {
  const res = await fetch(ANTHROPIC_API, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': env.ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: env.MODEL || 'claude-sonnet-5',
      max_tokens: 2048,
      output_config: { effort: 'medium' },
      system: [{ type: 'text', text: buildSystemPrompt(schema), cache_control: { type: 'ephemeral' } }],
      tools: [RUN_SQL_TOOL],
      messages,
    }),
  });
  if (!res.ok) {
    throw new Error(`Anthropic API ${res.status}: ${(await res.text()).slice(0, 500)}`);
  }
  return res.json();
}

// Claude only ever writes SQL — it never sees the rows a query returns. On a
// successful run_sql, we stop the loop right there and hand the result
// straight to the caller (chat page or Slack); Claude gets a data-free
// acknowledgment so the tool-use turn stays valid. A failed query still
// reports its error back to Claude (that's schema/syntax feedback, not user
// data) so it can retry.
export async function answerQuestion(env, schema, question) {
  const messages = [{ role: 'user', content: question }];

  for (let i = 0; i < MAX_TOOL_ITERATIONS; i++) {
    const response = await callClaude(env, messages, schema);

    if (response.stop_reason !== 'tool_use') {
      const text = response.content.find((b) => b.type === 'text');
      return { type: 'text', text: text ? text.text : "I couldn't come up with an answer." };
    }

    messages.push({ role: 'assistant', content: response.content });

    const toolResults = [];
    let tableResult = null;

    for (const block of response.content) {
      if (block.type !== 'tool_use') continue;
      const result = block.name === 'run_sql' ? await runSql(block.input.sql, env) : { error: 'Unknown tool' };

      if (block.name === 'run_sql' && !result.error) {
        tableResult = { type: 'table', sql: block.input.sql, ...result };
        toolResults.push({
          type: 'tool_result',
          tool_use_id: block.id,
          content: `Query ran successfully (${result.row_count} row(s)). Results are shown directly to the user — you don't need to describe them.`,
        });
      } else {
        toolResults.push({
          type: 'tool_result',
          tool_use_id: block.id,
          content: JSON.stringify(result),
          is_error: Boolean(result.error),
        });
      }
    }

    if (tableResult) return tableResult;

    messages.push({ role: 'user', content: toolResults });
  }

  return { type: 'text', text: "This question needed more steps than I'm allowed to take — try narrowing it down." };
}

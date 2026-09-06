# ai-data-agent

Ask a question in plain language, get an answer sourced from live Postgres
data — via Claude writing SQL and running it through Metabase's read-only
API. Built as an internal tool for a small team; this repo is a genericized
version with a made-up demo schema in place of any real company's data.

## Two ways to use this

1. **[`query.js`](query.js)** — a CLI: ask Claude (in a coding assistant
   session, or by hand) to write SQL against `src/metabase.js`'s thin
   Metabase client, for quick one-off exploration.
2. **Scout** — the actual product: a chat page + API that anyone on a team
   can use without a coding session open. Two interchangeable deployments
   of the same agent:
   - [`worker/`](worker/README.md) — a Cloudflare Worker, deploy to the
     public edge in minutes.
   - [`server/`](server/README.md) — the same logic as a plain Node
     `http` server (+ optional Slack bot), for environments that need to
     run somewhere Workers can't — e.g. inside a private network with no
     public exposure.

See [ARCHITECTURE.md](ARCHITECTURE.md) for the design decisions behind the
agent itself, in particular the **blind-to-rows** security model both
deployments share.

## Quick start (CLI)

```bash
npm install   # no dependencies yet, just sets things up
cp .env.example .env
# fill in METABASE_URL / METABASE_API_KEY (a read-only key)
node query.js                          # sanity check: lists connected databases
node query.js "SELECT count(*) FROM orders"
```

## Quick start (chat agent)

```bash
cd worker    # or: cd server
npm install
cp .dev.vars.example .dev.vars   # worker/; server/ uses .env.example instead
# fill in ANTHROPIC_API_KEY + METABASE_API_KEY
npm run dev
```

Both deployments ship with a small made-up demo schema
(`src/schema-demo.txt`) and matching example prompt rules
(`src/prompt.js`) so the agent runs out of the box. Swap both for your own
schema/rules to point this at a real database — see ARCHITECTURE.md for the
schema format and for which prompt rules are meant to be customized.

## Ground rules the agent follows

- `run_sql` is read-only-only: it refuses anything that looks like a write
  (INSERT/UPDATE/DELETE/DROP/ALTER/TRUNCATE/CREATE/GRANT) client-side, on
  top of using a read-only database credential in the first place — two
  independent layers, neither trusting the other alone.
- The agent never sees query *results* — only whether a query succeeded or
  failed. See [ARCHITECTURE.md](ARCHITECTURE.md) for why, and what that
  changes about how the agent has to write queries.

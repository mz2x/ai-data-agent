# Architecture

## The core loop

```
question
   → Claude (tool use, "run_sql" tool)
       → runs one SELECT via Metabase's REST API
       → result goes straight to the user as a table
       → Claude gets back only a success/error signal
```

`worker/src/index.js` and `server/src/agent.js` both implement the same
loop (`answerQuestion`): call Claude with the `run_sql` tool available, and
on the *first* successful query, stop and hand the result straight to
whatever's rendering it (chat page or Slack) instead of looping further.

## Why the agent never sees query results ("blind-to-rows")

The naive version of this pattern lets the model see rows back so it can
summarize or double-check them. That means every query result — including
whatever's actually in the database — passes through a third-party model
API. For an internal analytics tool, that's a real data-exposure surface
that's easy to miss until someone asks "wait, does the LLM provider see our
customer data?"

The fix used here: the tool result Claude receives on a successful query is
just an acknowledgment string ("N rows, shown to the user already"), never
the rows. Only on a *failed* query does the real error text go back to
Claude — that's schema/syntax feedback needed to retry, not user data.

This has a real consequence for how the agent has to behave, spelled out
explicitly in the system prompt (`worker/src/prompt.js`,
`server/src/prompt.js`): it can't run an exploratory "let me check what
values this column has" query and look at the result before committing to
a final answer, because it will never see that result — it would just get
shown to the user as if it *were* the answer. So the prompt requires one
complete, final query per question, and asks the model to raise a
clarifying question in text instead of probing with SQL when a question is
genuinely ambiguous.

## Two independent write-guards, not trusting either alone

1. The database credential itself should be read-only (a read-only
   Metabase API key, or a read-only Postgres role) — the actual security
   boundary.
2. `run_sql` *also* refuses client-side, by regex, anything that looks like
   a write (`INSERT`/`UPDATE`/`DELETE`/`DROP`/`ALTER`/`TRUNCATE`/`CREATE`/
   `GRANT`) before it's ever sent.

Neither layer is trusted to be sufficient alone — a leaked or
over-permissioned credential shouldn't be the only thing standing between a
model-generated query and a write, and a client-side regex shouldn't be the
only thing enforcing read-only-ness either.

## Two deployments, one reason: where the database is reachable from

`worker/` (Cloudflare Worker, public edge) and `server/` (plain Node
`http` server, containerizable) run the *same* agent logic
(`answerQuestion`, `buildSystemPrompt`, the same tool definition) — the
only difference is the runtime adapter around it (Workers'
`fetch(request, env)` export vs. Node's `http.createServer`).

The reason to have both: a Cloudflare Worker can only run on Cloudflare's
public edge network by design — it can't be placed inside a private
network or made reachable only over SSH/VPN. If the database (or the
analytics layer in front of it) is only reachable from inside a private
network, the Worker deployment is a non-starter regardless of how it's
configured, and the only fix is a deployment model that *can* run there — a
plain containerized process. `server/` is that: same logic, portable to
anywhere that can run a Docker container.

In general: exposing an internal data-query tool on the public internet
with no additional authentication in front of it is a real risk (anyone
with the URL could ask it questions, and every query costs the model
provider's API), independent of whether the queries themselves are
read-only. Prefer the private-network deployment where the option exists;
treat a public Worker deployment as fine for a scoped demo, not as the
default for a real internal tool.

## Cost awareness

Every question answered here is a real LLM API call — some non-trivial
amount of tokens for the system prompt (schema + rules) plus the question,
cached where the API supports it (`cache_control: { type: 'ephemeral' }`
on the system block) so repeat questions in the same session are cheap.
Worth keeping in mind before wiring up anything that calls `/api/ask` in a
loop (a health check, a test suite, a cron job) — that's real spend per
call, not a free endpoint.

## Customizing the schema and prompt rules for a real database

`src/schema-demo.txt` uses a compact format: one line per table,
`table_name(column:type, column:type?, ...)`, where a trailing `?` marks a
nullable column. Regenerate it from your own database's information_schema
(or an equivalent export) whenever the schema changes — the whole point is
that it's cheap enough to regenerate that it never goes stale.

`prompt.js`'s "Hard rules" section is deliberately written as a list of
specific, previously-painful lessons (a timezone-safe date-boundary
pattern, a "valid business object" filter, a couple of real Postgres
gotchas) rather than generic advice — that's the actual value of the
section. Replace the example rules with your own database's real gotchas as
you hit them; a generic "write good SQL" instruction is much weaker than a
short list of "here's the specific thing that broke last time."

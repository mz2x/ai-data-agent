# ai-data-agent-worker

Scout, as an actual product: a Cloudflare Worker that serves a chat page and
answers questions by writing SQL and running it through Metabase, using
Claude with tool use.

The Worker is the only thing that ever holds the API keys — nothing
sensitive reaches the browser.

```
Chat page (served by this Worker)
        ↓  POST /api/ask { question }
Worker  →  Claude API (tool-use loop)
              ↓ run_sql tool
           Metabase API  →  Postgres
```

## Local development

```bash
npm install
cp .dev.vars.example .dev.vars   # fill in ANTHROPIC_API_KEY (+ METABASE_API_KEY once you have it)
npm run dev                       # http://localhost:8787
```

`.dev.vars` is gitignored — never commit it.

## Deploy

Secrets are set once, directly on Cloudflare — never in a file in this repo:

```bash
npx wrangler secret put ANTHROPIC_API_KEY
npx wrangler secret put METABASE_API_KEY
npm run deploy
```

`wrangler deploy` prints the live URL. Re-run `npm run deploy` any time
`src/` changes; secrets don't need to be re-set unless the keys themselves
change.

## Notes

- `run_sql` refuses anything that looks like a write (INSERT/UPDATE/DELETE/
  DROP/ALTER/TRUNCATE/CREATE/GRANT) client-side, on top of the Metabase key
  being read-only — see the root [README](../README.md) and
  [ARCHITECTURE.md](../ARCHITECTURE.md) for the full safety story, including
  why Claude never sees query results.
- `src/schema-demo.txt` is a small made-up schema so this runs out of the
  box — swap it for a compact export of your own database (see
  [ARCHITECTURE.md](../ARCHITECTURE.md) for the format).
- Model defaults to `claude-sonnet-5` (set via the `MODEL` var in
  `wrangler.jsonc`).

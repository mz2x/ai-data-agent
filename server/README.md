# ai-data-agent-server

A containerized port of [`../worker/`](../worker/README.md) — same agent,
same `src/prompt.js` / `src/schema-demo.txt` / `src/chat.html` (kept in
sync by hand, deliberately not shared as a package between the two, since
they're two small runtime adapters around the same core logic), but running
as a plain Node `http` server instead of a Cloudflare Worker. Use this
version wherever the Worker deployment model doesn't fit — e.g. inside a
private VPC, reachable only via SSH/bastion, with no public internet
exposure at all.

## Why this exists

Cloudflare Workers only deploy to Cloudflare's public edge network — they
can't run inside a private VPC or sit behind SSH-only access by design. If
your database (or the analytics layer in front of it) can only be reached
from inside a private network, you need something that *can* run there: a
plain containerized Node process. This is that.

## What's different from `worker/`

- `src/index.js` uses Node's built-in `http` module instead of the Workers
  `fetch(request, env)` export — same routes (`/`, `/health`,
  `/debug/metabase`, `POST /api/ask`), same `answerQuestion` tool-use loop,
  same blind-query behavior (Claude never sees rows — see the root
  [ARCHITECTURE.md](../ARCHITECTURE.md)).
- `schema-demo.txt` and `chat.html` are read from disk at startup instead
  of Wrangler's text-import `rules`.
- Env vars come from `process.env` (loaded from `.env` locally) instead of
  Cloudflare bindings/secrets.
- Includes an optional Slack bot ([`src/slack.js`](src/slack.js)) — Socket
  Mode, so no public URL is needed. Access control is membership in one
  private Slack channel rather than a hardcoded allowlist: whoever can see
  that channel can use the bot (there or by DM), and removing someone from
  the channel removes their access, with nothing to redeploy per person.

## Local run

```bash
cp .env.example .env   # fill in ANTHROPIC_API_KEY, METABASE_API_KEY, METABASE_URL
npm install
npm start               # http://localhost:8787
```

`/health` and `/debug/metabase` don't call Claude (free to hit while
testing); `/api/ask` does.

## Docker

```bash
docker build -t ai-data-agent .
docker run -p 8787:8787 --env-file .env ai-data-agent
```

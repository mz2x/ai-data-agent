import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { answerQuestion } from './agent.js';
import { startSlackBot } from './slack.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

try {
  process.loadEnvFile(path.join(__dirname, '..', '.env'));
} catch (err) {
  if (err.code !== 'ENOENT') throw err;
}

const PORT = process.env.PORT || 8787;
const env = process.env;

const SCHEMA = await readFile(path.join(__dirname, 'schema-demo.txt'), 'utf8');
const CHAT_HTML = await readFile(path.join(__dirname, 'chat.html'), 'utf8');

function json(res, data, status = 200) {
  const body = JSON.stringify(data);
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(body);
}

async function readBody(req) {
  let raw = '';
  for await (const chunk of req) raw += chunk;
  return raw;
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);

  try {
    if (req.method === 'GET' && url.pathname === '/') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(CHAT_HTML);
      return;
    }

    if (req.method === 'GET' && url.pathname === '/health') {
      json(res, { ok: true, metabase_configured: Boolean(env.METABASE_API_KEY) });
      return;
    }

    // Diagnostic route — hits Metabase directly, no Claude/Anthropic involved.
    if (req.method === 'GET' && url.pathname === '/debug/metabase') {
      const r = await fetch(`${env.METABASE_URL}/api/database`, {
        headers: { 'x-api-key': env.METABASE_API_KEY },
      });
      const bodyText = await r.text();
      json(res, { status: r.status, statusText: r.statusText, body: bodyText.slice(0, 1000) });
      return;
    }

    if (req.method === 'POST' && url.pathname === '/api/ask') {
      let body;
      try {
        body = JSON.parse((await readBody(req)) || '{}');
      } catch {
        json(res, { error: 'Invalid JSON body' }, 400);
        return;
      }
      const question = (body.question || '').trim();
      if (!question) {
        json(res, { error: 'Missing "question"' }, 400);
        return;
      }
      if (!env.ANTHROPIC_API_KEY) {
        json(res, { error: 'ANTHROPIC_API_KEY is not configured' }, 500);
        return;
      }

      const result = await answerQuestion(env, SCHEMA, question);
      json(res, result);
      return;
    }

    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('Not found');
  } catch (err) {
    json(res, { error: String(err.message || err) }, 500);
  }
});

server.listen(PORT, () => {
  console.log(`Data agent listening on :${PORT}`);
});

if (env.SLACK_BOT_TOKEN && env.SLACK_APP_TOKEN) {
  startSlackBot(env, SCHEMA).catch((err) => {
    console.error('Slack bot failed to start:', err);
  });
} else {
  console.log('SLACK_BOT_TOKEN/SLACK_APP_TOKEN not set — Slack bot disabled, chat page still works.');
}

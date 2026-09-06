import pkg from '@slack/bolt';
import { answerQuestion } from './agent.js';

const { App } = pkg;

const MAX_SLACK_ROWS = 30; // Slack messages are for eyeballing, not exporting — keep it short.

// Access control is membership in a private Slack channel, not a hardcoded
// list — whoever can see that channel can use the bot (in that channel or
// by DM), and removing them from the channel removes their access. No
// server-side list to keep in sync by hand.
async function isChannelMember(client, channelId, userId) {
  const res = await client.conversations.members({ channel: channelId });
  return res.members.includes(userId);
}

function stripMention(text) {
  return text.replace(/<@[A-Z0-9]+>/g, '').trim();
}

function formatTable({ sql, cols, rows, row_count, truncated }) {
  if (!rows.length) {
    return '```' + sql + '```\n_No rows returned._';
  }

  const shown = rows.slice(0, MAX_SLACK_ROWS);
  const widths = cols.map((c, i) =>
    Math.max(c.length, ...shown.map((r) => String(r[c] ?? '—').length)),
  );
  const line = (cells) => cells.map((v, i) => String(v).padEnd(widths[i])).join(' | ');

  const header = line(cols);
  const sep = widths.map((w) => '-'.repeat(w)).join('-|-');
  const body = shown.map((r) => line(cols.map((c) => r[c] ?? '—'))).join('\n');

  const shownNote =
    shown.length < rows.length
      ? `Showing first ${shown.length} of ${row_count} rows.`
      : truncated
        ? `Showing first ${rows.length} of ${row_count} rows.`
        : `${row_count} row${row_count === 1 ? '' : 's'}`;

  return '```' + sql + '```\n```' + header + '\n' + sep + '\n' + body + '```\n_' + shownNote + '_';
}

export async function startSlackBot(env, schema) {
  const app = new App({
    token: env.SLACK_BOT_TOKEN,
    appToken: env.SLACK_APP_TOKEN,
    socketMode: true,
  });

  if (!env.SLACK_TEAM_CHANNEL_ID) {
    console.log('SLACK_TEAM_CHANNEL_ID is not set — the Slack bot cannot check access, so it will refuse everyone.');
  }

  async function handleQuestion({ userId, text, say }) {
    const question = stripMention(text);
    if (!question) return;

    const member = env.SLACK_TEAM_CHANNEL_ID && (await isChannelMember(app.client, env.SLACK_TEAM_CHANNEL_ID, userId));
    if (!member) {
      await say("Sorry, you don't have access to this bot yet — ask an admin to add you to the access channel.");
      return;
    }

    try {
      const result = await answerQuestion(env, schema, question);
      if (result.type === 'table') {
        await say(formatTable(result));
      } else {
        await say(result.text);
      }
    } catch (err) {
      await say(`Something went wrong: ${String(err.message || err)}`);
    }
  }

  app.event('app_mention', async ({ event, say }) => {
    await handleQuestion({ userId: event.user, text: event.text, say });
  });

  app.message(async ({ message, say }) => {
    if (message.channel_type !== 'im') return;
    if (message.subtype || message.bot_id) return;
    await handleQuestion({ userId: message.user, text: message.text, say });
  });

  await app.start();
  console.log('Slack bot connected via Socket Mode.');
}

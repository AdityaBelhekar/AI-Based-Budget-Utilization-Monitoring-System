// Vercel runs this file as one serverless function; vercel.json sends every /api request here.
import { createApp } from '../server/src/app.js';
import { connectDb } from '../server/src/db.js';

// Trimmed, because a value pasted into the Vercel dashboard or piped in can carry a trailing line break.
const [MONGODB_URI, SESSION_SECRET, CRON_SECRET] = ['MONGODB_URI', 'SESSION_SECRET', 'CRON_SECRET'].map((k) => process.env[k]?.trim());

let ready = null;
// Started on the first request rather than at load, so a missing setting answers with an error instead of crashing the function.
function start() {
  ready ??= (async () => {
    const missing = ['MONGODB_URI', 'SESSION_SECRET'].filter((k, i) => ![MONGODB_URI, SESSION_SECRET][i]);
    if (missing.length) throw new Error(`Missing in the Vercel project settings: ${missing.join(', ')}`);
    await connectDb(MONGODB_URI);
    return createApp({ sessionSecret: SESSION_SECRET, production: true, cronSecret: CRON_SECRET });
  })().catch((err) => {
    ready = null;
    throw err;
  });
  return ready;
}

export default async function handler(req, res) {
  try {
    const app = await start();
    return app(req, res);
  } catch (err) {
    console.error(err);
    res.statusCode = 503;
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ error: 'The service is starting or misconfigured. Try again shortly.' }));
  }
}

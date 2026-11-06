// Vercel runs this file as one serverless function; vercel.json sends every /api request here.
import { createApp } from '../server/src/app.js';
import { connectDb } from '../server/src/db.js';

const { MONGODB_URI, SESSION_SECRET, CRON_SECRET } = process.env;

const ready = (async () => {
  if (!MONGODB_URI || !SESSION_SECRET) throw new Error('MONGODB_URI and SESSION_SECRET must be set in the Vercel project');
  await connectDb(MONGODB_URI);
  return createApp({ sessionSecret: SESSION_SECRET, production: true, cronSecret: CRON_SECRET });
})();

export default async function handler(req, res) {
  try {
    const app = await ready;
    return app(req, res);
  } catch (err) {
    console.error(err);
    res.statusCode = 503;
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ error: 'The service is starting or misconfigured. Try again shortly.' }));
  }
}

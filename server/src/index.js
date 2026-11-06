import path from 'node:path';
import { createApp } from './app.js';
import { connectDb } from './db.js';

const { MONGODB_URI, SESSION_SECRET, CRON_SECRET, PORT = 3000, NODE_ENV } = process.env;
if (!MONGODB_URI || !SESSION_SECRET) {
  console.error('MONGODB_URI and SESSION_SECRET must be set');
  process.exit(1);
}

await connectDb(MONGODB_URI);
const clientDir = path.resolve(import.meta.dirname, '../../client/dist/client/browser');
createApp({ sessionSecret: SESSION_SECRET, production: NODE_ENV === 'production', clientDir, cronSecret: CRON_SECRET }).listen(PORT, () =>
  console.log(`Listening on port ${PORT}`),
);

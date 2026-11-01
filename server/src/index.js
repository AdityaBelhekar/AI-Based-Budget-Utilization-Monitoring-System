import path from 'node:path';
import mongoose from 'mongoose';
import { createApp } from './app.js';

const { MONGODB_URI, SESSION_SECRET, PORT = 3000, NODE_ENV } = process.env;
if (!MONGODB_URI || !SESSION_SECRET) {
  console.error('MONGODB_URI and SESSION_SECRET must be set');
  process.exit(1);
}

await mongoose.connect(MONGODB_URI);
const clientDir = path.resolve(import.meta.dirname, '../../client/dist/client/browser');
createApp({ sessionSecret: SESSION_SECRET, production: NODE_ENV === 'production', clientDir }).listen(PORT, () =>
  console.log(`Listening on port ${PORT}`),
);

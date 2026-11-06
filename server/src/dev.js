import mongoose from 'mongoose';
import { MongoMemoryReplSet } from 'mongodb-memory-server';
import { seedPublishedData } from './seed-data.js';
import { seedUsers } from './seed-users.js';

// A replica set because budget writes will use transactions. Data is lost when this process stops.
if (!process.env.MONGODB_URI) {
  // Reuse the binary the install cached, wherever this process was started from.
  process.env.MONGOMS_DOWNLOAD_DIR ??= `${import.meta.dirname}/../node_modules/.cache/mongodb-memory-server`;
  const db = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
  process.env.MONGODB_URI = db.getUri('budget');
}
await mongoose.connect(process.env.MONGODB_URI);
await seedPublishedData();
await seedUsers();
await import('./index.js');

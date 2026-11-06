import mongoose from 'mongoose';
import { initModels } from './models.js';

// Serverless instances are reused between requests, so one connection per instance is kept and shared.
let connecting = null;
export function connectDb(uri) {
  connecting ??= mongoose
    .connect(uri, { maxPoolSize: 5, serverSelectionTimeoutMS: 10000 })
    .then(initModels)
    .catch((err) => {
      connecting = null;
      throw err;
    });
  return connecting;
}

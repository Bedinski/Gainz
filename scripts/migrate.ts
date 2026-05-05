import '../src/lib/env.js';
import { applySchema } from '../src/db/migrate.js';
import { getDb } from '../src/db/client.js';

getDb();
applySchema();
console.log('schema applied');

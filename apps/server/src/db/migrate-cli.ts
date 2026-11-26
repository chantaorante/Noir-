import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { createPool } from './pool.js';
import { migrate } from './migrate.js';

const url = process.env.DATABASE_URL;
if (!url) throw new Error('DATABASE_URL is required');
const dir = process.env.MIGRATIONS_DIR ?? path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../../db/migrations');
const db = createPool(url, 2);
const ran = await migrate(db, dir, (m) => console.log(m));
console.log(ran.length ? `${ran.length} migration(s) applied.` : 'Database is up to date.');
await db.end();

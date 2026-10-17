/**
 * npm run db:migrate   – apply pending migrations
 * npm run db:seed      – load sample foods + starter recipes (add --force to overwrite edited seed recipes)
 */
import { openDatabase, migrate } from './connection';
import { seedDatabase } from './seed';
import { loadConfig } from '../server/config';

const cmd = process.argv[2];
const config = loadConfig();
const db = openDatabase(config.databasePath);

if (cmd === 'migrate') {
  const ran = migrate(db);
  console.log(ran.length ? `Applied: ${ran.join(', ')}` : 'Database is up to date.');
} else if (cmd === 'seed') {
  migrate(db);
  const force = process.argv.includes('--force');
  const result = seedDatabase(db, { force });
  console.log(`Sample foods: ${result.foods}. Recipes created ${result.recipes.created}, updated ${result.recipes.updated}, unchanged ${result.recipes.skipped}.`);
} else {
  console.log('Usage: tsx src/database/cli.ts <migrate|seed> [--force]');
  process.exitCode = 1;
}
db.close();

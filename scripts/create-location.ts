// Usage: npm run bootstrap:location -- --name "<location name>". LOCAL D1 only.
import { assertLocationName, buildCreateLocationSql, executeLocalSql, parseFlags, runMain } from './lib.ts';

const USAGE = 'Usage: npm run bootstrap:location -- --name "<location name>"';

await runMain(async () => {
  const flags = parseFlags(process.argv.slice(2), ['name']);
  const name = assertLocationName(flags.get('name'));
  const id = crypto.randomUUID();
  await executeLocalSql(buildCreateLocationSql({ id, name }));
  process.stdout.write(`${JSON.stringify({ id, name })}\n`);
}, USAGE);

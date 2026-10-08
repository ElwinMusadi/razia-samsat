// Usage: npm run bootstrap:user -- --username <name> --role <ADMIN|OFFICER> [--iterations <10..100000>]
// The password is read from stdin only (hidden prompt on a terminal, or piped). LOCAL D1 only.
import { hashPassword } from '../shared/password.ts';
import { normalizeUsername } from '../shared/username.ts';
import { assertRole, buildCreateUserSql, executeLocalSql, parseFlags, readPassword, resolveIterations, runMain, UsageError } from './lib.ts';

const USAGE = 'Usage: npm run bootstrap:user -- --username <name> --role <ADMIN|OFFICER> [--iterations <10..100000>] (password via stdin)';

await runMain(async () => {
  const flags = parseFlags(process.argv.slice(2), ['username', 'role', 'iterations']);
  const username = normalizeUsername(flags.get('username'));
  if (username === null) throw new UsageError('Username must match ^[a-z0-9._-]{1,100}$ after trim/lowercase');
  const role = assertRole(flags.get('role'));
  const iterations = await resolveIterations(flags.get('iterations'));
  const password = await readPassword();
  const id = crypto.randomUUID();
  const passwordHash = await hashPassword(password, iterations);
  await executeLocalSql(buildCreateUserSql({ id, username, role, passwordHash, iterations }));
  process.stdout.write(`${JSON.stringify({ id, username, role, iterations })}\n`);
}, USAGE);

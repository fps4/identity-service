/**
 * Admin CLI for local-credential users (RQ-0002). The operator-side counterpart to self-service
 * registration: create users, reset passwords, and lock/unlock/disable accounts — the password-reset
 * path while there is no email channel. Run with tsx against the service's table. Predates the record
 * (ADR-0022): nothing here is recorded — use the management plane for an act that should be.
 *
 *   tsx scripts/manage-users.ts create       --email=<e> --password=<p>
 *   tsx scripts/manage-users.ts set-password  --email=<e> --password=<p>
 *   tsx scripts/manage-users.ts lock|unlock|disable|enable|delete --email=<e>
 *
 * Users are deployment-scoped (ADR-0018): email is the unique key, no tenant.
 * TABLE_NAME / DYNAMODB_ENDPOINT / AWS_REGION come from the environment (or .env), same as the service.
 */
import process from 'process';
import { randomUUID } from 'crypto';
import { getStore, Transaction } from '../src/db/index.js';
import { hashSecret } from '../src/utils/hash.js';
import { assertPasswordPolicy, normalizeEmail } from '../src/services/users.js';

function parseArgs() {
  const [command, ...rest] = process.argv.slice(2);
  const args = new Map<string, string>();
  for (const entry of rest) {
    const [key, value] = entry.split('=');
    if (key?.startsWith('--') && value !== undefined) args.set(key.replace(/^--/, ''), value);
  }
  return { command, args };
}

async function main() {
  const { command, args } = parseArgs();
  const email = args.get('email') ? normalizeEmail(args.get('email')!) : undefined;
  if (!command || !email) {
    console.error('Usage: manage-users <create|set-password|lock|unlock|disable|enable|delete> --email=<e> [--password=<p>]');
    process.exitCode = 2;
    return;
  }

  const store = getStore();
  const now = new Date();

  switch (command) {
    case 'create': {
      const password = args.get('password');
      if (!password) throw new Error('--password is required for create');
      assertPasswordPolicy(password);
      const existing = await store.users.getByEmail(email);
      if (existing) throw new Error(`User already exists: ${email}`);
      const id = randomUUID();
      const tx = new Transaction();
      store.users.put(tx, { _id: id, email, passwordHash: hashSecret(password), identities: [], emailVerified: false, status: 'active', failedAttempts: 0, passwordUpdatedAt: now, createdAt: now, updatedAt: now });
      await store.commit(tx);
      console.log(`created user ${id} (${email}) — this id is the token sub; assign an application for access (ADR-0019)`);
      break;
    }
    case 'set-password': {
      const password = args.get('password');
      if (!password) throw new Error('--password is required for set-password');
      assertPasswordPolicy(password);
      const user = await store.users.getByEmail(email);
      const updated = user && await store.users.update(user._id, { passwordHash: hashSecret(password), passwordUpdatedAt: now, failedAttempts: 0, lockedUntil: null, updatedAt: now });
      report(updated ? 1 : 0, email, 'password reset');
      break;
    }
    case 'lock':
    case 'unlock':
    case 'disable':
    case 'enable':
    case 'delete': {
      const user = await store.users.getByEmail(email);
      if (!user) { report(0, email, command); break; }
      if (command === 'delete') {
        const tx = new Transaction();
        store.users.delete(tx, user);
        await store.commit(tx);
        report(1, email, 'deleted');
        break;
      }
      const set =
        command === 'lock' ? { status: 'locked' as const, lockedUntil: null }
        : command === 'unlock' ? { status: 'active' as const, failedAttempts: 0, lockedUntil: null }
        : command === 'disable' ? { status: 'disabled' as const }
        : { status: 'active' as const, failedAttempts: 0, lockedUntil: null };
      const updated = await store.users.update(user._id, { ...set, updatedAt: now });
      report(updated ? 1 : 0, email, command);
      break;
    }
    default:
      throw new Error(`Unknown command: ${command}`);
  }
}

function report(count: number, email: string, action: string) {
  if (!count) {
    console.error(`No user matched ${email}`);
    process.exitCode = 1;
  } else {
    console.log(`${action}: ${email}`);
  }
}

main().catch((err) => { console.error(err.message ?? err); process.exitCode = 1; });

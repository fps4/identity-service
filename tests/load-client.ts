// Manual test harness loader (ADR-0018). One deployment = one realm, so there is no tenant to seed —
// this just puts an OAuth client in the table for local/manual testing (ADR-0023: TABLE_NAME and, on a
// laptop, DYNAMODB_ENDPOINT from the environment). Prefer `npm run seed` for real config; this stays as
// a quick throwaway-client helper for the manual-test-harness.html. Not a recorded act (ADR-0022): the
// credential it makes is a client_credentials one with no principal; use the management plane for one
// that should be.
import { readFileSync } from 'fs';
import process from 'process';
import { randomUUID } from 'crypto';
import { getStore } from '../service/src/db/index.js';
import { hashSecret } from '../service/src/utils/hash.js';

interface Options {
  clientFile: string;
  applicationId: string;
  clientName?: string;
  clientScopes?: string[];
  outputSecret?: boolean;
}

function parseArgs(): Options {
  const args = new Map<string, string>();
  for (const entry of process.argv.slice(2)) {
    const [key, value] = entry.split('=');
    if (key && value) args.set(key.replace(/^--/, ''), value);
  }

  const clientFile = args.get('clientFile') ?? 'tests/new-client.json';
  const applicationId = args.get('applicationId') ?? 'manual-harness';
  const clientName = args.get('clientName') ?? undefined;
  const clientScopes = args.get('clientScopes')?.split(',').map((value) => value.trim()).filter(Boolean);
  const outputSecret = args.get('outputSecret') === 'true';

  return { clientFile, applicationId, clientName, clientScopes, outputSecret };
}

async function main() {
  const options = parseArgs();
  const payload = JSON.parse(readFileSync(options.clientFile, 'utf-8'));
  const store = getStore();
  const now = new Date();

  // A credential lives under an application (ADR-0020); make the harness's if it is not there yet.
  if (!(await store.applications.get(options.applicationId))) {
    await store.applications.create({ _id: options.applicationId, name: 'Manual Harness', audience: payload.audience, roles: [], resources: [] }, now);
  }

  const clientId = payload.id ?? randomUUID();
  const secret = randomUUID().replace(/-/g, '');
  await store.clients.create({
    _id: clientId,
    applicationId: options.applicationId,
    name: options.clientName ?? payload.name ?? 'Manual Harness Client',
    secretHash: hashSecret(secret),
    grantTypes: payload.grantTypes ?? ['client_credentials'],
    redirectUris: [],
    scopes: options.clientScopes && options.clientScopes.length ? options.clientScopes : payload.scopes ?? [],
    audience: payload.audience,
    isConfidential: payload.isConfidential ?? true,
    createdAt: now,
    updatedAt: now
  });
  console.log(`Provisioned client ${clientId}`);
  if (options.outputSecret) {
    console.log(`Client secret: ${secret}`);
  }
}

main().catch((error) => {
  console.error('Failed to load client', error);
  process.exit(1);
});

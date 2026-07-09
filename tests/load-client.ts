// Manual test harness loader (ADR-0018). One deployment = one realm, so there is no tenant to seed —
// this just inserts an OAuth client for local/manual testing. Prefer `npm run seed` for real config;
// this stays as a quick throwaway-client helper for the manual-test-harness.html.
import { readFileSync } from 'fs';
import process from 'process';
import { randomUUID } from 'crypto';
import { createRequire } from 'module';
const requireFromService = createRequire(new URL('../service/package.json', import.meta.url));
import type * as mongooseType from 'mongoose';
const mongoose = requireFromService('mongoose') as typeof mongooseType;
import { hashSecret } from '../service/src/utils/hash.js';

interface Options {
  mongoUri: string;
  dbName: string;
  clientFile: string;
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

  const mongoUri = args.get('mongoUri') ?? process.env.MONGO_URI ?? 'mongodb://localhost:27017';
  const dbName = args.get('dbName') ?? process.env.MONGO_DB_NAME ?? 'identity-service';
  const clientFile = args.get('clientFile') ?? 'tests/new-client.json';
  const clientName = args.get('clientName') ?? undefined;
  const clientScopes = args.get('clientScopes')?.split(',').map((value) => value.trim()).filter(Boolean);
  const outputSecret = args.get('outputSecret') === 'true';

  return { mongoUri, dbName, clientFile, clientName, clientScopes, outputSecret };
}

async function main() {
  const options = parseArgs();
  const payload = JSON.parse(readFileSync(options.clientFile, 'utf-8'));

  const connection = await mongoose.createConnection(`${options.mongoUri}/${options.dbName}`).asPromise();
  const { getOAuthClientModel } = await import('../service/src/models/oauth-client.js');
  const OAuthClient = getOAuthClientModel(connection);

  const clientId = payload.id ?? randomUUID();
  const secret = randomUUID().replace(/-/g, '');
  await OAuthClient.create({
    _id: clientId,
    name: options.clientName ?? payload.name ?? 'Manual Harness Client',
    secretHash: hashSecret(secret),
    grantTypes: payload.grantTypes ?? ['client_credentials'],
    scopes: options.clientScopes && options.clientScopes.length ? options.clientScopes : payload.scopes ?? [],
    audience: payload.audience,
    isConfidential: payload.isConfidential ?? true
  });
  console.log(`Provisioned client ${clientId}`);
  if (options.outputSecret) {
    console.log(`Client secret: ${secret}`);
  }

  await connection.close();
}

main().catch((error) => {
  console.error('Failed to load client', error);
  process.exit(1);
});

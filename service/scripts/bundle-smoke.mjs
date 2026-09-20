// Does the service bundle boot? Start bundle/service/index.mjs against a port nothing listens on and
// read what it dies of. A connection failure means every module resolved and the server reached its
// database step — the bundle is sound. Anything else (a missing package, a bad require, an undefined
// __dirname) is a bundling defect and fails here rather than at the first cold start.
import { spawn } from 'node:child_process';
import { resolve } from 'node:path';

const entry = resolve('bundle', 'service', 'index.mjs');
const child = spawn(process.execPath, [entry], {
  env: {
    ...process.env,
    NODE_ENV: 'production',
    LOG_PRETTY: 'false',
    PORT: '17305',
    MONGO_URI: 'mongodb://127.0.0.1:1',
    MONGO_DB_NAME: 'smoke',
    AUTH_JWT_ISSUER: 'https://identity.example',
    OAUTH_KEY_PASSPHRASE: 'smoke'
  },
  stdio: ['ignore', 'pipe', 'pipe']
});

let output = '';
child.stdout.on('data', (d) => (output += d));
child.stderr.on('data', (d) => (output += d));

// The driver's server selection gives up after 30s; allow for it.
const timer = setTimeout(() => {
  child.kill('SIGKILL');
  console.error(output);
  console.error('bundle smoke: the server neither started nor failed within 60s');
  process.exit(1);
}, 60_000);

child.on('exit', (code) => {
  clearTimeout(timer);
  const connectionFailure = /failed to connect to MongoDB|MongooseServerSelectionError|ECONNREFUSED/.test(output);
  const resolutionFailure = /Cannot find (package|module)|ERR_MODULE_NOT_FOUND|is not defined|Dynamic require of/.test(output);
  if (connectionFailure && !resolutionFailure) {
    console.log('bundle smoke: ok — every module resolved; the server reached its database step and failed there as intended');
    process.exit(0);
  }
  console.error(output);
  console.error(`bundle smoke: unexpected exit ${code}`);
  process.exit(1);
});

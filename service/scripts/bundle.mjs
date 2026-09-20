// Bundle each Lambda entry point into one ESM file and zip it, reproducibly: fixed mtimes, no extra
// attributes, so the same source gives the same bytes and Terraform's source_code_hash only changes
// when the code does. Output: bundle/<name>/… and bundle/<name>.zip — outside dist/, which is what the
// container image runs; the bundle is what the Terraform module (terraform/) deploys.
//
//   service  the Express server, unchanged, behind the Lambda Web Adapter in zip mode: the handler is
//            run.sh, which execs node on the bundle; the adapter (a layer) proxies API Gateway events
//            to the port the service listens on.
//   backup   the scheduled backup (lambda/backup.ts): every item of the table to S3 as JSON lines.
//   relay    the scheduled relay (src/relay/lambda.ts, ADR-0022 §5): the spine's relayHandler over this
//            service's outbox, into the archive and the events topic the spine's module names.
import { build } from 'esbuild';
import { execFileSync } from 'node:child_process';
import { chmod, mkdir, rm, utimes, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const FUNCTIONS = {
  service: { entry: 'src/server.ts', webAdapter: true },
  backup: { entry: 'lambda/backup.ts', webAdapter: false },
  relay: { entry: 'src/relay/lambda.ts', webAdapter: false }
};

// pino loads its pretty transport by name at runtime when LOG_PRETTY=true; the module sets it false.
const RUNTIME_OPTIONALS = ['pino-pretty'];

const EPOCH = new Date('2020-01-01T00:00:00Z');
const RUN_SH = '#!/bin/bash\nexec node index.mjs\n';

for (const [name, { entry, webAdapter }] of Object.entries(FUNCTIONS)) {
  const dir = resolve('bundle', name);
  await rm(dir, { recursive: true, force: true });
  await mkdir(dir, { recursive: true });
  await build({
    entryPoints: [entry],
    outfile: resolve(dir, 'index.mjs'),
    bundle: true,
    platform: 'node',
    target: 'node22',
    format: 'esm',
    sourcemap: false,
    minify: false,
    legalComments: 'none',
    external: RUNTIME_OPTIONALS,
    banner: {
      // CommonJS dependencies (the AWS SDK, pino, express) keep their require()/__dirname; give them both.
      js: [
        "import { createRequire } from 'node:module';",
        "import { fileURLToPath } from 'node:url';",
        "import { dirname } from 'node:path';",
        'const require = createRequire(import.meta.url);',
        'const __filename = fileURLToPath(import.meta.url);',
        'const __dirname = dirname(__filename);'
      ].join(' ')
    },
    logLevel: 'warning'
  });
  const files = [resolve(dir, 'index.mjs')];
  if (webAdapter) {
    const runSh = resolve(dir, 'run.sh');
    await writeFile(runSh, RUN_SH);
    await chmod(runSh, 0o755);
    files.push(runSh);
  }
  for (const file of files) await utimes(file, EPOCH, EPOCH);
  const zip = resolve('bundle', `${name}.zip`);
  await rm(zip, { force: true });
  execFileSync('zip', ['-X', '-q', '-j', zip, ...files]);
  console.log(zip);
}

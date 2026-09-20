/**
 * Decrypt one `.enc` backup object for a restore (the passphrase in BACKUP_PASSPHRASE):
 *
 *   BACKUP_PASSPHRASE=… npm run backup:decrypt -- user.jsonl.gz.enc user.jsonl.gz
 *   gunzip user.jsonl.gz && npm run backup:restore -- user.jsonl     # PutItem per line into TABLE_NAME
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { decryptBackup } from './backup-crypto.js';

const [input, output] = process.argv.slice(2);
const passphrase = process.env.BACKUP_PASSPHRASE;
if (!input || !output || !passphrase) {
  console.error('usage: BACKUP_PASSPHRASE=… tsx lambda/backup-decrypt.ts <in.enc> <out>');
  process.exit(2);
}
writeFileSync(output, decryptBackup(readFileSync(input), passphrase));
console.log(output);

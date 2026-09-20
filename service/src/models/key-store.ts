/**
 * An RSA signing key (RS256). The private key is stored encrypted under OAUTH_KEY_PASSPHRASE
 * (`utils/key-store.ts`). `kid` is the key: `realm#key_store` / `<kid>` (ADR-0023).
 */
export interface KeyStoreDocument {
  kid: string;
  privateKey: string; // PEM, encrypted if configured
  publicKey: string; // PEM
  algorithm: 'RS256';
  status: 'active' | 'inactive' | 'retired';
  createdAt?: Date;
  rotatedAt?: Date | null;
}

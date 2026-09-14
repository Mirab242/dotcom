import * as crypto from 'crypto';

const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 12; // recommandé pour GCM

/**
 * Chiffrement enveloppe simplifié : la clé maîtresse vient d'une variable d'env pour l'instant
 * (voir §4.10 de l'architecture — à remplacer par un vrai KMS/Vault avant la prod réelle).
 * Format de sortie : "<iv>:<authTag>:<ciphertext>" en hex.
 */
export function encryptSecret(plainText: string, masterKeyHex: string): string {
  const key = Buffer.from(masterKeyHex, 'hex');
  const iv = crypto.randomBytes(IV_LENGTH);
  const cipher = crypto.createCipheriv(ALGORITHM, key, iv);
  const encrypted = Buffer.concat([cipher.update(plainText, 'utf8'), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return `${iv.toString('hex')}:${authTag.toString('hex')}:${encrypted.toString('hex')}`;
}

export function decryptSecret(payload: string, masterKeyHex: string): string {
  const [ivHex, authTagHex, dataHex] = payload.split(':');
  const key = Buffer.from(masterKeyHex, 'hex');
  const decipher = crypto.createDecipheriv(ALGORITHM, key, Buffer.from(ivHex, 'hex'));
  decipher.setAuthTag(Buffer.from(authTagHex, 'hex'));
  const decrypted = Buffer.concat([
    decipher.update(Buffer.from(dataHex, 'hex')),
    decipher.final(),
  ]);
  return decrypted.toString('utf8');
}

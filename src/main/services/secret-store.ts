import { safeStorage } from 'electron'

/**
 * At-rest encoding for API keys in `providers.json`. A sealed value is the
 * OS-keychain-encrypted string (`safeStorage`) behind a prefix, so a legacy
 * plaintext key is still readable and gets resealed on the next write.
 */
const SEALED_PREFIX = 'enc:v1:'

export function isSealedSecret(stored: string): boolean {
  return stored.startsWith(SEALED_PREFIX)
}

/** Encrypts `plain`; without an OS keychain it is stored as-is, as before. */
export function sealSecret(plain: string): string {
  if (plain === '' || isSealedSecret(plain) || !safeStorage.isEncryptionAvailable()) return plain
  return SEALED_PREFIX + safeStorage.encryptString(plain).toString('base64')
}

/** The plaintext secret, or `null` when a sealed value cannot be decrypted here. */
export function openSecret(stored: string): string | null {
  if (!isSealedSecret(stored)) return stored
  try {
    return safeStorage.decryptString(Buffer.from(stored.slice(SEALED_PREFIX.length), 'base64'))
  } catch {
    return null
  }
}

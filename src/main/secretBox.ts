/** Abstraction over OS-protected secret storage (Electron safeStorage / DPAPI on Windows). */
export interface SecretBox {
  readonly available: boolean;
  encrypt(plain: string): string;
  decrypt(encoded: string): string;
}

/** Used in tests and when OS protection is unavailable. Stores secrets unprotected. */
export const plainBox: SecretBox = {
  available: false,
  encrypt: (s) => s,
  decrypt: (s) => s,
};

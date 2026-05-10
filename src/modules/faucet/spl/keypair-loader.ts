import { ConfigService } from '@nestjs/config';
import { Keypair } from '@solana/web3.js';

/**
 * Load a Solana `Keypair` from a base64-encoded 64-byte secret key
 * stashed in an environment variable.
 *
 * Hard requirements:
 *   - `configService.get<string>(envName)` must return a non-empty string.
 *   - The base64 payload MUST decode to exactly 64 bytes (ed25519
 *     secret = 32-byte seed + 32-byte public key, the format
 *     `Keypair.fromSecretKey` expects).
 *
 * Error messages contain ONLY the env-var name and the decoded
 * buffer length — never the value or any prefix of it. A leaked stack
 * trace in production logs must never reveal a private key.
 */
export function loadKeypairFromB64Env(
  envName: string,
  label: string,
  configService: ConfigService,
): Keypair {
  const raw = configService.get<string>(envName);
  if (!raw) {
    throw new Error(`Invalid ${label} keypair env var (length=0)`);
  }

  let buf: Buffer;
  try {
    buf = Buffer.from(raw, 'base64');
  } catch {
    // `Buffer.from(..., 'base64')` is famously lenient — it never
    // actually throws — but guarding here keeps the boundary
    // future-proof if we ever switch to a stricter decoder.
    throw new Error(`Invalid ${label} keypair env var (length=0)`);
  }

  if (buf.length !== 64) {
    throw new Error(`Invalid ${label} keypair env var (length=${buf.length})`);
  }

  try {
    return Keypair.fromSecretKey(new Uint8Array(buf));
  } catch {
    // Re-wrap to ensure no underlying error message can leak any
    // partial bytes (web3.js's error text is benign today, but we
    // pin the contract here regardless).
    throw new Error(`Invalid ${label} keypair env var (length=${buf.length})`);
  }
}

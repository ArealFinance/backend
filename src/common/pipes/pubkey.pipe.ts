import { BadRequestException, Injectable, PipeTransform } from '@nestjs/common';
import { PublicKey } from '@solana/web3.js';

/**
 * Validates and canonicalises a base58 Solana pubkey.
 *
 * Why a custom pipe (vs class-validator `@IsString`):
 *   - We need a real `PublicKey.isOnCurve`-style check; a plain regex would
 *     accept off-curve trash that crashes downstream RPC calls.
 *   - We want a canonical base58 string back — `new PublicKey(input).toBase58()`
 *     normalises any leading-zero edge cases.
 *
 * Throws `BadRequestException` (400) on invalid input — Nest will format it
 * via the global exception filter.
 */
@Injectable()
export class PubkeyPipe implements PipeTransform<string, string> {
  transform(value: string): string {
    if (typeof value !== 'string' || value.length === 0) {
      throw new BadRequestException('pubkey is required');
    }
    try {
      // PublicKey constructor decodes base58 and validates length (32 bytes).
      // Re-encoding via toBase58() yields a canonical string.
      return new PublicKey(value).toBase58();
    } catch {
      throw new BadRequestException(`invalid base58 pubkey: ${value}`);
    }
  }
}

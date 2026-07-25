import { ServiceUnavailableException } from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';
import { PublicKey, type Connection } from '@solana/web3.js';
import { describe, expect, it, vi } from 'vitest';

import {
  MAINNET_STAKING_PROGRAM_ID,
  UnstakeTicketsService,
} from './unstake-tickets.service.js';

const OWNER = 'DYw8jCTfwHNRJhhmFcbXvVDTqWMEVFBX6ZKUmG5CNSKK';
function ticketData(amount: bigint, unlockTsSeconds: bigint, nonce: bigint, bump: number): Buffer {
  const data = Buffer.alloc(65);
  Buffer.from([0x83, 0x54, 0xd1, 0x26, 0x91, 0x9d, 0xb5, 0x7f]).copy(data, 0);
  new PublicKey(OWNER).toBuffer().copy(data, 8);
  data.writeBigUInt64LE(amount, 40);
  data.writeBigInt64LE(unlockTsSeconds, 48);
  data.writeBigUInt64LE(nonce, 56);
  data[64] = bump;
  return data;
}

function makeTicket(amount: bigint, unlockTsSeconds: bigint, nonce: bigint) {
  const nonceLe = Buffer.alloc(8);
  nonceLe.writeBigUInt64LE(nonce);
  const [pubkey, bump] = PublicKey.findProgramAddressSync(
    [Buffer.from('unstake'), new PublicKey(OWNER).toBuffer(), nonceLe],
    MAINNET_STAKING_PROGRAM_ID,
  );
  return {
    pubkey,
    account: {
      owner: MAINNET_STAKING_PROGRAM_ID,
      data: ticketData(amount, unlockTsSeconds, nonce, bump),
    },
  };
}

function makeConnection(getProgramAccounts: ReturnType<typeof vi.fn>): Connection {
  return { getProgramAccounts } as unknown as Connection;
}

function mainnetConfig(): ConfigService {
  return { get: vi.fn().mockReturnValue('mainnet') } as unknown as ConfigService;
}

function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
} {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((onResolve) => {
    resolve = onResolve;
  });
  return { promise, resolve };
}

describe('UnstakeTicketsService', () => {
  it('uses the pinned mainnet program and fixed ticket filters', async () => {
    const getProgramAccounts = vi.fn().mockResolvedValue([]);
    const service = new UnstakeTicketsService(makeConnection(getProgramAccounts), mainnetConfig());

    await expect(service.listForWallet(OWNER)).resolves.toEqual({ tickets: [] });

    expect(getProgramAccounts).toHaveBeenCalledWith(MAINNET_STAKING_PROGRAM_ID, {
      commitment: 'confirmed',
      filters: [{ dataSize: 65 }, { memcmp: { offset: 8, bytes: OWNER } }],
    });
  });

  it('coalesces concurrent scans for the canonical wallet, then removes the entry on settle', async () => {
    const upstream = deferred<[]>();
    const getProgramAccounts = vi.fn().mockReturnValue(upstream.promise);
    const service = new UnstakeTicketsService(makeConnection(getProgramAccounts), mainnetConfig());

    const first = service.listForWallet(OWNER);
    const second = service.listForWallet(OWNER);
    expect(getProgramAccounts).toHaveBeenCalledOnce();

    upstream.resolve([]);
    await expect(Promise.all([first, second])).resolves.toEqual([{ tickets: [] }, { tickets: [] }]);

    await service.listForWallet(OWNER);
    expect(getProgramAccounts).toHaveBeenCalledTimes(2);
  });

  it('does not retain a failed request in the in-flight map', async () => {
    const getProgramAccounts = vi
      .fn()
      .mockRejectedValueOnce(new Error('upstream unavailable'))
      .mockResolvedValueOnce([]);
    const service = new UnstakeTicketsService(makeConnection(getProgramAccounts), mainnetConfig());

    await expect(service.listForWallet(OWNER)).rejects.toBeInstanceOf(ServiceUnavailableException);
    await expect(service.listForWallet(OWNER)).resolves.toEqual({ tickets: [] });
    expect(getProgramAccounts).toHaveBeenCalledTimes(2);
  });

  it('decodes ticket fields and sorts by unlock timestamp', async () => {
    const late = makeTicket(12_345_678n, 1_800_000_000n, 9n);
    const early = makeTicket(2_500_000n, 1_700_000_000n, 18_446_744_073_709_551_615n);
    const getProgramAccounts = vi.fn().mockResolvedValue([late, early]);
    const service = new UnstakeTicketsService(makeConnection(getProgramAccounts), mainnetConfig());

    await expect(service.listForWallet(OWNER)).resolves.toEqual({
      tickets: [
        {
          ticket: early.pubkey.toBase58(),
          amountRwtBaseUnits: '2500000',
          unlockTsSec: '1700000000',
          nonce: '18446744073709551615',
        },
        {
          ticket: late.pubkey.toBase58(),
          amountRwtBaseUnits: '12345678',
          unlockTsSec: '1800000000',
          nonce: '9',
        },
      ],
    });
  });

  it('skips accounts that fail program owner, discriminator, wallet owner, PDA or bump verification', async () => {
    const valid = makeTicket(1_000_000n, 1_700_000_000n, 1n);
    const badDiscriminator = makeTicket(2_000_000n, 1_700_000_001n, 2n);
    badDiscriminator.account.data[0] = 0;
    const wrongOwner = makeTicket(3_000_000n, 1_700_000_002n, 3n);
    new PublicKey('So11111111111111111111111111111111111111112').toBuffer().copy(wrongOwner.account.data, 8);
    const badPda = makeTicket(4_000_000n, 1_700_000_003n, 4n);
    badPda.account.data[64] = (badPda.account.data[64]! + 1) % 256;
    const wrongProgramOwner = makeTicket(5_000_000n, 1_700_000_004n, 5n);
    wrongProgramOwner.account.owner = new PublicKey(
      'So11111111111111111111111111111111111111112',
    );
    const getProgramAccounts = vi.fn().mockResolvedValue([
      {
        pubkey: valid.pubkey,
        account: { owner: MAINNET_STAKING_PROGRAM_ID, data: Buffer.alloc(64) },
      },
      badDiscriminator,
      wrongOwner,
      badPda,
      wrongProgramOwner,
      valid,
    ]);
    const service = new UnstakeTicketsService(makeConnection(getProgramAccounts), mainnetConfig());

    await expect(service.listForWallet(OWNER)).resolves.toEqual({
      tickets: [
        {
          ticket: valid.pubkey.toBase58(),
          amountRwtBaseUnits: '1000000',
          unlockTsSec: '1700000000',
          nonce: '1',
        },
      ],
    });
  });

  it('fails closed outside mainnet before calling RPC', async () => {
    const getProgramAccounts = vi.fn();
    const devnetConfig = { get: vi.fn().mockReturnValue('devnet') } as unknown as ConfigService;
    const service = new UnstakeTicketsService(makeConnection(getProgramAccounts), devnetConfig);

    await expect(service.listForWallet(OWNER)).rejects.toBeInstanceOf(ServiceUnavailableException);
    expect(getProgramAccounts).not.toHaveBeenCalled();
  });

  it('maps upstream RPC failures to a controlled 503 without provider details', async () => {
    const getProgramAccounts = vi
      .fn()
      .mockRejectedValue(new Error('https://rpc.example/?api-key=secret'));
    const service = new UnstakeTicketsService(makeConnection(getProgramAccounts), mainnetConfig());

    await expect(service.listForWallet(OWNER)).rejects.toEqual(
      expect.objectContaining({
        message: 'Solana RPC temporarily unavailable',
        status: 503,
      }),
    );
    await expect(service.listForWallet(OWNER)).rejects.toBeInstanceOf(ServiceUnavailableException);
  });
});

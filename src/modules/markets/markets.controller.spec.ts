import { BadRequestException } from '@nestjs/common';
import { describe, expect, it, vi } from 'vitest';

import type { HoldersService } from './holders/holders.service.js';
import { MarketsController } from './markets.controller.js';
import type { MarketsService } from './markets.service.js';

const VALID_POOL = 'DYw8jCTfwHNRJhhmFcbXvVDTqWMEVFBX6ZKUmG5CNSKK';
const VALID_MINT = 'So11111111111111111111111111111111111111112';

function makeHolders(): HoldersService {
  return { getHolders: vi.fn() } as unknown as HoldersService;
}

describe('MarketsController', () => {
  it('listSnapshots delegates to service when pool is valid', async () => {
    const expected = { items: [] };
    const service = {
      listSnapshots: vi.fn().mockResolvedValue(expected),
      listAggregate: vi.fn(),
      getSummary: vi.fn(),
    };
    const ctrl = new MarketsController(service as unknown as MarketsService, makeHolders());
    const result = await ctrl.listSnapshots(VALID_POOL, {});
    expect(service.listSnapshots).toHaveBeenCalledWith(VALID_POOL, {});
    expect(result).toBe(expected);
  });

  it('listSnapshots rejects malformed pool with 400', () => {
    const service = {
      listSnapshots: vi.fn(),
      listAggregate: vi.fn(),
      getSummary: vi.fn(),
    };
    const ctrl = new MarketsController(service as unknown as MarketsService, makeHolders());
    expect(() => ctrl.listSnapshots('not-a-pubkey', {})).toThrow(BadRequestException);
    expect(service.listSnapshots).not.toHaveBeenCalled();
  });

  it('listAggregate rejects malformed pool with 400', () => {
    const service = {
      listSnapshots: vi.fn(),
      listAggregate: vi.fn(),
      getSummary: vi.fn(),
    };
    const ctrl = new MarketsController(service as unknown as MarketsService, makeHolders());
    expect(() => ctrl.listAggregate('!!!!', {})).toThrow(BadRequestException);
    expect(service.listAggregate).not.toHaveBeenCalled();
  });

  it('getSummary delegates with no params', async () => {
    const expected = { totalTvlUsd: 0 };
    const service = {
      listSnapshots: vi.fn(),
      listAggregate: vi.fn(),
      getSummary: vi.fn().mockResolvedValue(expected),
    };
    const ctrl = new MarketsController(service as unknown as MarketsService, makeHolders());
    const result = await ctrl.getSummary();
    expect(service.getSummary).toHaveBeenCalledOnce();
    expect(result).toBe(expected);
  });

  it('getTokenHolders delegates to HoldersService when mint valid', async () => {
    const expected = {
      mint: VALID_MINT,
      count: 42,
      updatedAt: '2026-05-10T00:00:00.000Z',
      source: 'rpc' as const,
    };
    const service = {
      listSnapshots: vi.fn(),
      listAggregate: vi.fn(),
      getSummary: vi.fn(),
    };
    const holders = {
      getHolders: vi.fn().mockResolvedValue(expected),
    } as unknown as HoldersService;
    const ctrl = new MarketsController(service as unknown as MarketsService, holders);
    const result = await ctrl.getTokenHolders(VALID_MINT);
    expect(holders.getHolders).toHaveBeenCalledWith(VALID_MINT);
    expect(result).toBe(expected);
  });

  it('getTokenHolders rejects malformed mint with 400', () => {
    const service = {
      listSnapshots: vi.fn(),
      listAggregate: vi.fn(),
      getSummary: vi.fn(),
    };
    const holders = { getHolders: vi.fn() } as unknown as HoldersService;
    const ctrl = new MarketsController(service as unknown as MarketsService, holders);
    expect(() => ctrl.getTokenHolders('not-a-mint')).toThrow(BadRequestException);
    expect(holders.getHolders).not.toHaveBeenCalled();
  });
});

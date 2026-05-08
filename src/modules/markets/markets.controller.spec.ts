import { BadRequestException } from '@nestjs/common';
import { describe, expect, it, vi } from 'vitest';

import { MarketsController } from './markets.controller.js';
import type { MarketsService } from './markets.service.js';

const VALID_POOL = 'DYw8jCTfwHNRJhhmFcbXvVDTqWMEVFBX6ZKUmG5CNSKK';

describe('MarketsController', () => {
  it('listSnapshots delegates to service when pool is valid', async () => {
    const expected = { items: [] };
    const service = {
      listSnapshots: vi.fn().mockResolvedValue(expected),
      listAggregate: vi.fn(),
      getSummary: vi.fn(),
    };
    const ctrl = new MarketsController(service as unknown as MarketsService);
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
    const ctrl = new MarketsController(service as unknown as MarketsService);
    expect(() => ctrl.listSnapshots('not-a-pubkey', {})).toThrow(BadRequestException);
    expect(service.listSnapshots).not.toHaveBeenCalled();
  });

  it('listAggregate rejects malformed pool with 400', () => {
    const service = {
      listSnapshots: vi.fn(),
      listAggregate: vi.fn(),
      getSummary: vi.fn(),
    };
    const ctrl = new MarketsController(service as unknown as MarketsService);
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
    const ctrl = new MarketsController(service as unknown as MarketsService);
    const result = await ctrl.getSummary();
    expect(service.getSummary).toHaveBeenCalledOnce();
    expect(result).toBe(expected);
  });
});

import { BadRequestException } from '@nestjs/common';
import { describe, expect, it, vi } from 'vitest';

import { PortfolioController } from './portfolio.controller.js';
import type { PortfolioService } from './portfolio.service.js';

const VALID_WALLET = 'DYw8jCTfwHNRJhhmFcbXvVDTqWMEVFBX6ZKUmG5CNSKK';

describe('PortfolioController', () => {
  it('listClaims delegates to service when wallet is valid', async () => {
    const expected = { items: [], nextCursor: null };
    const service = { listClaims: vi.fn().mockResolvedValue(expected), listLpPositions: vi.fn() };
    const ctrl = new PortfolioController(service as unknown as PortfolioService);
    const result = await ctrl.listClaims(VALID_WALLET, {});
    expect(service.listClaims).toHaveBeenCalledWith(VALID_WALLET, {});
    expect(result).toBe(expected);
  });

  it('listLpPositions delegates to service when wallet is valid', async () => {
    const expected = { items: [], nextCursor: null };
    const service = { listClaims: vi.fn(), listLpPositions: vi.fn().mockResolvedValue(expected) };
    const ctrl = new PortfolioController(service as unknown as PortfolioService);
    const result = await ctrl.listLpPositions(VALID_WALLET, {});
    expect(service.listLpPositions).toHaveBeenCalledWith(VALID_WALLET, {});
    expect(result).toBe(expected);
  });

  it('listClaims rejects malformed wallet path param with 400', () => {
    const service = { listClaims: vi.fn(), listLpPositions: vi.fn() };
    const ctrl = new PortfolioController(service as unknown as PortfolioService);
    expect(() => ctrl.listClaims('not-a-pubkey', {})).toThrow(BadRequestException);
    expect(service.listClaims).not.toHaveBeenCalled();
  });

  it('listLpPositions rejects malformed wallet path param with 400', () => {
    const service = { listClaims: vi.fn(), listLpPositions: vi.fn() };
    const ctrl = new PortfolioController(service as unknown as PortfolioService);
    expect(() => ctrl.listLpPositions('!!!!', {})).toThrow(BadRequestException);
    expect(service.listLpPositions).not.toHaveBeenCalled();
  });

  it('passes optional ot filter through to listClaims', async () => {
    const service = {
      listClaims: vi.fn().mockResolvedValue({ items: [], nextCursor: null }),
      listLpPositions: vi.fn(),
    };
    const ctrl = new PortfolioController(service as unknown as PortfolioService);
    await ctrl.listClaims(VALID_WALLET, { ot: 'OT-mint', limit: 5 });
    expect(service.listClaims).toHaveBeenCalledWith(VALID_WALLET, { ot: 'OT-mint', limit: 5 });
  });

  it('passes optional pool filter through to listLpPositions', async () => {
    const service = {
      listClaims: vi.fn(),
      listLpPositions: vi.fn().mockResolvedValue({ items: [], nextCursor: null }),
    };
    const ctrl = new PortfolioController(service as unknown as PortfolioService);
    await ctrl.listLpPositions(VALID_WALLET, { pool: 'POOL', before: 'cursor' });
    expect(service.listLpPositions).toHaveBeenCalledWith(VALID_WALLET, {
      pool: 'POOL',
      before: 'cursor',
    });
  });
});

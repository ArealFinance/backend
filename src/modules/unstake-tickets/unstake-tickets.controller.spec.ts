import { BadRequestException } from '@nestjs/common';
import { describe, expect, it, vi } from 'vitest';

import type { UnstakeTicketsService } from './unstake-tickets.service.js';
import { UnstakeTicketsController } from './unstake-tickets.controller.js';

const VALID_OWNER = 'DYw8jCTfwHNRJhhmFcbXvVDTqWMEVFBX6ZKUmG5CNSKK';

describe('UnstakeTicketsController', () => {
  it('delegates a canonical valid owner to the service', async () => {
    const expected = { tickets: [] };
    const tickets = {
      listForWallet: vi.fn().mockResolvedValue(expected),
    } as unknown as UnstakeTicketsService;
    const controller = new UnstakeTicketsController(tickets);

    await expect(controller.list(VALID_OWNER)).resolves.toBe(expected);
    expect(tickets.listForWallet).toHaveBeenCalledWith(VALID_OWNER);
  });

  it('rejects invalid owner before invoking the service', () => {
    const tickets = { listForWallet: vi.fn() } as unknown as UnstakeTicketsService;
    const controller = new UnstakeTicketsController(tickets);

    expect(() => controller.list('not-a-wallet')).toThrow(BadRequestException);
    expect(tickets.listForWallet).not.toHaveBeenCalled();
  });
});

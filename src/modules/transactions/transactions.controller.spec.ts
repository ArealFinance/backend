import { describe, expect, it, vi } from 'vitest';

import { TransactionsController } from './transactions.controller.js';
import type { ListTransactionsDto } from './dto/list-transactions.dto.js';
import type { TransactionsService } from './transactions.service.js';

describe('TransactionsController', () => {
  it('delegates list() to the service and returns its response verbatim', async () => {
    const expected = { items: [], nextCursor: null };
    const service = { list: vi.fn().mockResolvedValue(expected) };
    const ctrl = new TransactionsController(service as unknown as TransactionsService);
    const query: ListTransactionsDto = { wallet: 'wallet-1' };
    const result = await ctrl.list(query);
    expect(service.list).toHaveBeenCalledWith(query);
    expect(result).toBe(expected);
  });

  it('passes through optional kind/limit/before filters unchanged', async () => {
    const service = { list: vi.fn().mockResolvedValue({ items: [], nextCursor: null }) };
    const ctrl = new TransactionsController(service as unknown as TransactionsService);
    const query: ListTransactionsDto = {
      wallet: 'wallet-2',
      kind: 'swap',
      limit: 25,
      before: 'cursor-token',
    };
    await ctrl.list(query);
    expect(service.list).toHaveBeenCalledWith(query);
  });
});

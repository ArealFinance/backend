import { describe, expect, it, beforeEach, vi } from 'vitest';

import { FaucetController } from './faucet.controller.js';
import { FaucetClaimDto } from './dto/faucet-claim.dto.js';

/**
 * Unit tests for FaucetController. Tests cover:
 * - Controller delegates to service
 * - DTO is passed correctly to service
 */

describe('FaucetController', () => {
  let controller: FaucetController;
  let mockService: any;

  beforeEach(() => {
    mockService = {
      claim: vi.fn().mockResolvedValue({
        success: true,
        signature: 'test-sig',
        ata: 'test-ata',
        amount: 1000,
      }),
    };

    controller = new FaucetController(mockService);
  });

  describe('POST /faucet/usdc', () => {
    it('should call service.claim with wallet and amount', async () => {
      const dto: FaucetClaimDto = {
        wallet: 'DYw8jCTfwHNRJhhmFcbXvVDTqWMEVFBX6ZKUmG5CNSKK',
        amount: 1000,
      };

      const result = await controller.claim(dto);

      expect(mockService.claim).toHaveBeenCalledWith(
        'DYw8jCTfwHNRJhhmFcbXvVDTqWMEVFBX6ZKUmG5CNSKK',
        1000,
      );
      expect(result.success).toBe(true);
    });

    it('should call service.claim with wallet only (amount optional)', async () => {
      const dto: FaucetClaimDto = {
        wallet: 'DYw8jCTfwHNRJhhmFcbXvVDTqWMEVFBX6ZKUmG5CNSKK',
      };

      const result = await controller.claim(dto);

      expect(mockService.claim).toHaveBeenCalledWith(
        'DYw8jCTfwHNRJhhmFcbXvVDTqWMEVFBX6ZKUmG5CNSKK',
        undefined,
      );
      expect(result.success).toBe(true);
    });

    it('should return response from service', async () => {
      const dto: FaucetClaimDto = {
        wallet: 'DYw8jCTfwHNRJhhmFcbXvVDTqWMEVFBX6ZKUmG5CNSKK',
      };

      const result = await controller.claim(dto);

      expect(result).toEqual({
        success: true,
        signature: 'test-sig',
        ata: 'test-ata',
        amount: 1000,
      });
    });
  });
});

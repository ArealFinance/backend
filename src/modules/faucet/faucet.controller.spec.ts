import { describe, expect, it, beforeEach, vi } from 'vitest';

import { FaucetController } from './faucet.controller.js';
import { FaucetClaimDto } from './dto/faucet-claim.dto.js';
import { FaucetRwtClaimDto } from './dto/faucet-rwt-claim.dto.js';

/**
 * Unit tests for FaucetController. Tests cover:
 * - Controller delegates to USDC service
 * - Controller delegates to RWT service
 * - DTOs are passed correctly to each service
 */

describe('FaucetController', () => {
  let controller: FaucetController;
  let mockUsdcService: any;
  let mockRwtService: any;

  beforeEach(() => {
    mockUsdcService = {
      claim: vi.fn().mockResolvedValue({
        success: true,
        signature: 'usdc-sig',
        ata: 'usdc-ata',
        amount: 1000,
      }),
    };
    mockRwtService = {
      claimRwt: vi.fn().mockResolvedValue({
        success: true,
        signature: 'rwt-sig',
        ata: 'rwt-ata',
        amount: 100,
      }),
    };

    controller = new FaucetController(mockUsdcService, mockRwtService);
  });

  describe('POST /faucet/usdc', () => {
    it('should call service.claim with wallet and amount', async () => {
      const dto: FaucetClaimDto = {
        wallet: 'DYw8jCTfwHNRJhhmFcbXvVDTqWMEVFBX6ZKUmG5CNSKK',
        amount: 1000,
      };

      const result = await controller.claim(dto);

      expect(mockUsdcService.claim).toHaveBeenCalledWith(
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

      expect(mockUsdcService.claim).toHaveBeenCalledWith(
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
        signature: 'usdc-sig',
        ata: 'usdc-ata',
        amount: 1000,
      });
    });
  });

  describe('POST /faucet/rwt', () => {
    it('should call rwtFaucetService.claimRwt with wallet and amount', async () => {
      const dto: FaucetRwtClaimDto = {
        wallet: 'DYw8jCTfwHNRJhhmFcbXvVDTqWMEVFBX6ZKUmG5CNSKK',
        amount: 100,
      };

      const result = await controller.claimRwt(dto);

      expect(mockRwtService.claimRwt).toHaveBeenCalledWith(
        'DYw8jCTfwHNRJhhmFcbXvVDTqWMEVFBX6ZKUmG5CNSKK',
        100,
      );
      expect(result.success).toBe(true);
    });

    it('should call rwtFaucetService.claimRwt with wallet only (amount optional)', async () => {
      const dto: FaucetRwtClaimDto = {
        wallet: 'DYw8jCTfwHNRJhhmFcbXvVDTqWMEVFBX6ZKUmG5CNSKK',
      };

      const result = await controller.claimRwt(dto);

      expect(mockRwtService.claimRwt).toHaveBeenCalledWith(
        'DYw8jCTfwHNRJhhmFcbXvVDTqWMEVFBX6ZKUmG5CNSKK',
        undefined,
      );
      expect(result.success).toBe(true);
    });

    it('should not invoke USDC service for RWT route', async () => {
      const dto: FaucetRwtClaimDto = {
        wallet: 'DYw8jCTfwHNRJhhmFcbXvVDTqWMEVFBX6ZKUmG5CNSKK',
      };

      await controller.claimRwt(dto);

      expect(mockUsdcService.claim).not.toHaveBeenCalled();
    });

    it('should not invoke RWT service for USDC route', async () => {
      const dto: FaucetClaimDto = {
        wallet: 'DYw8jCTfwHNRJhhmFcbXvVDTqWMEVFBX6ZKUmG5CNSKK',
      };

      await controller.claim(dto);

      expect(mockRwtService.claimRwt).not.toHaveBeenCalled();
    });
  });
});

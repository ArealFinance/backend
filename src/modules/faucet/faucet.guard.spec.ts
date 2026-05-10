import { NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Mock } from 'vitest';
import { describe, expect, it, beforeEach, vi } from 'vitest';

import { LocalnetOnlyGuard } from './faucet.guard.js';
import type { SolanaCluster } from '../../config/configuration.js';

/**
 * Unit tests for LocalnetOnlyGuard. Tests cover:
 * - Guard returns true for localnet cluster
 * - Guard throws NotFoundException for all other clusters
 */

describe('LocalnetOnlyGuard', () => {
  let guard: LocalnetOnlyGuard;
  let configService: ConfigService;

  beforeEach(() => {
    configService = {
      get: (key: string) => 'localnet',
    } as unknown as ConfigService;
    guard = new LocalnetOnlyGuard(configService);
  });

  it('should return true for localnet', () => {
    const mockContext = {
      switchToHttp: () => ({
        getRequest: () => ({}),
      }),
    } as any;

    const result = guard.canActivate(mockContext);
    expect(result).toBe(true);
  });

  it('should throw NotFoundException for devnet', () => {
    configService = {
      get: (key: string) => 'devnet' as SolanaCluster,
    } as unknown as ConfigService;
    guard = new LocalnetOnlyGuard(configService);

    const mockContext = {
      switchToHttp: () => ({
        getRequest: () => ({}),
      }),
    } as any;

    expect(() => guard.canActivate(mockContext)).toThrow(NotFoundException);
  });

  it('should throw NotFoundException for mainnet', () => {
    configService = {
      get: (key: string) => 'mainnet' as SolanaCluster,
    } as unknown as ConfigService;
    guard = new LocalnetOnlyGuard(configService);

    const mockContext = {
      switchToHttp: () => ({
        getRequest: () => ({}),
      }),
    } as any;

    expect(() => guard.canActivate(mockContext)).toThrow(NotFoundException);
  });

  it('should throw NotFoundException for testnet', () => {
    configService = {
      get: (key: string) => 'testnet' as SolanaCluster,
    } as unknown as ConfigService;
    guard = new LocalnetOnlyGuard(configService);

    const mockContext = {
      switchToHttp: () => ({
        getRequest: () => ({}),
      }),
    } as any;

    expect(() => guard.canActivate(mockContext)).toThrow(NotFoundException);
  });

  it('should read cluster config from ConfigService', () => {
    const mockConfigService = {
      get: vi.fn().mockReturnValue('localnet'),
    } as unknown as ConfigService;
    guard = new LocalnetOnlyGuard(mockConfigService);

    const mockContext = {
      switchToHttp: () => ({
        getRequest: () => ({}),
      }),
    } as any;

    guard.canActivate(mockContext);

    expect((mockConfigService.get as unknown as Mock)).toHaveBeenCalledWith('solana.cluster');
  });
});

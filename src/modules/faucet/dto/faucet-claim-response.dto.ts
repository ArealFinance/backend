import { ApiProperty } from '@nestjs/swagger';

/**
 * Faucet claim response — only emitted on a confirmed mint transaction.
 */
export class FaucetClaimResponseDto {
  @ApiProperty({ description: 'Always `true` on a confirmed claim.' })
  success!: boolean;

  @ApiProperty({
    description: 'Confirmed mint transaction signature (base58).',
    example: '5o2x...8vQc',
  })
  signature!: string;

  @ApiProperty({
    description: 'Recipient associated token account (base58).',
  })
  ata!: string;

  @ApiProperty({
    description: 'Drip amount in whole USDC.',
    example: 1000,
  })
  amount!: number;
}

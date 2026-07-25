import { ApiProperty } from '@nestjs/swagger';

/** One pending mainnet staking cooldown receipt. */
export class UnstakeTicketDto {
  @ApiProperty({
    description: 'UnstakeTicket PDA (base58)',
    example: '7CEkANsGYKgsjiPfoB6RWuPv9tU9AMdBK9uRWTkm3tFx',
  })
  ticket!: string;

  @ApiProperty({
    description: 'RWT amount fixed at unstake initiation, in 6-decimal base units',
    example: '12500000',
  })
  amountRwtBaseUnits!: string;

  @ApiProperty({
    description: 'Unix timestamp in seconds when this ticket can be claimed',
    example: '1784390400',
  })
  unlockTsSec!: string;

  @ApiProperty({
    description: 'Client-supplied u64 nonce, encoded as a decimal string',
    example: '42',
  })
  nonce!: string;
}

/** Response for the public per-wallet pending-mainnet-unstake query. */
export class UnstakeTicketsResponseDto {
  @ApiProperty({ type: [UnstakeTicketDto] })
  tickets!: UnstakeTicketDto[];
}

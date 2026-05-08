import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsInt, IsOptional, IsString, Matches, Max, Min } from 'class-validator';

export class ListLpPositionsDto {
  @ApiPropertyOptional({ description: 'Filter to a single AMM pool (base58)' })
  @IsOptional()
  @IsString()
  @Matches(/^[1-9A-HJ-NP-Za-km-z]{32,44}$/, { message: 'pool must be a base58 pubkey' })
  pool?: string;

  @ApiPropertyOptional({ default: 10, minimum: 1, maximum: 50 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(50)
  limit?: number;

  @ApiPropertyOptional({ description: 'Opaque cursor returned by previous page' })
  @IsOptional()
  @IsString()
  before?: string;
}

export class LpPositionRowDto {
  @ApiProperty() signature!: string;
  @ApiProperty() logIndex!: number;
  @ApiProperty() wallet!: string;
  @ApiProperty() pool!: string;
  @ApiProperty({ enum: ['add', 'remove', 'zap'] }) kind!: 'add' | 'remove' | 'zap';
  @ApiProperty() amountA!: string;
  @ApiProperty() amountB!: string;
  @ApiProperty({ description: 'Signed: positive on add/zap, negative on remove' })
  sharesDelta!: string;
  @ApiProperty() blockTime!: string;
}

export class ListLpPositionsResponseDto {
  @ApiProperty({ type: [LpPositionRowDto] }) items!: LpPositionRowDto[];
  @ApiPropertyOptional({ nullable: true }) nextCursor!: string | null;
}

import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsInt, IsOptional, IsString, Matches, Max, Min } from 'class-validator';

export class ListClaimsDto {
  @ApiPropertyOptional({ description: 'Filter to a single OT mint (base58)' })
  @IsOptional()
  @IsString()
  @Matches(/^[1-9A-HJ-NP-Za-km-z]{32,44}$/, { message: 'ot must be a base58 pubkey' })
  ot?: string;

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

export class ClaimRowDto {
  @ApiProperty() signature!: string;
  @ApiProperty() logIndex!: number;
  @ApiProperty() wallet!: string;
  @ApiProperty() otMint!: string;
  @ApiProperty() amount!: string;
  @ApiProperty() cumulativeClaimed!: string;
  @ApiProperty() blockTime!: string;
}

export class ListClaimsResponseDto {
  @ApiProperty({ type: [ClaimRowDto] }) items!: ClaimRowDto[];
  @ApiPropertyOptional({ nullable: true }) nextCursor!: string | null;
}

import { ApiProperty } from '@nestjs/swagger';

export class AuthResponseDto {
  @ApiProperty({ description: 'Short-lived JWT access token' })
  accessToken!: string;

  @ApiProperty({ description: 'Long-lived rotation refresh token (opaque, hashed server-side)' })
  refreshToken!: string;

  @ApiProperty({ description: 'Authenticated wallet pubkey (base58)' })
  wallet!: string;

  @ApiProperty({ description: 'Access-token expiry (ISO-8601)' })
  expiresAt!: string;
}

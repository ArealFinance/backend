import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

/**
 * JSON-RPC 2.0 request envelope — documentation/typing only.
 *
 * NOTE: this DTO is NOT used as a `@Body()` validation target. A JSON-RPC
 * payload may be either a single object OR a batch array, and `params` is an
 * open-ended structure that differs per method — class-validator's
 * whitelist/forbidNonWhitelisted (enabled globally) would either strip
 * legitimate fields or reject valid batches. The proxy therefore takes the
 * raw body and validates its shape structurally in `RpcProxyService`
 * (`validateRpcRequest`). This class exists so Swagger documents the expected
 * request shape and so the service has a typed view of a single request.
 */
export class JsonRpcRequestDto {
  @ApiProperty({ description: 'JSON-RPC version — must be "2.0".', example: '2.0' })
  jsonrpc!: string;

  @ApiProperty({
    description: 'RPC method name. Must be in the proxy allow-list.',
    example: 'getLatestBlockhash',
  })
  method!: string;

  @ApiPropertyOptional({
    description: 'Method parameters (array or object, method-specific).',
    example: [],
  })
  params?: unknown;

  @ApiProperty({
    description: 'Caller-chosen request id (string or number); echoed in the response.',
    example: 1,
  })
  id!: string | number | null;
}

/** Narrow, runtime-validated view of a single JSON-RPC request. */
export interface JsonRpcRequest {
  jsonrpc: string;
  method: string;
  params?: unknown;
  id: string | number | null;
}

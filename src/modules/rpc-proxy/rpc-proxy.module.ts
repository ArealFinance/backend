import { Module } from '@nestjs/common';

import { RpcProxyController } from './rpc-proxy.controller.js';
import { RpcProxyService } from './rpc-proxy.service.js';

/**
 * Public JSON-RPC proxy module.
 *
 * Exposes `POST /rpc`, forwarding an allow-listed set of JSON-RPC methods to
 * the server-side Solana RPC (`solana.rpcUrl`, set from Helius env on the
 * server). Keeps the Helius key server-only so the web app / Seeker APK never
 * embed it.
 *
 * Self-contained: depends only on the global ConfigModule (for the upstream
 * URL + tunables) and the app-wide ThrottlerGuard (registered at root) for
 * per-IP rate limiting. CORS is enforced globally in `main.ts`.
 */
@Module({
  controllers: [RpcProxyController],
  providers: [RpcProxyService],
})
export class RpcProxyModule {}

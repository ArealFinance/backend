import {
  ArgumentsHost,
  BadRequestException,
  Catch,
  ExceptionFilter,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import type { Request, Response } from 'express';

/**
 * Global exception filter producing a stable JSON error envelope.
 *
 * Shape (matches Areal `nestjs.md` rules):
 *   {
 *     statusCode: number,
 *     message: string | string[],
 *     error?: string,
 *     path: string,
 *     timestamp: string
 *   }
 *
 * Internal errors (anything not a `HttpException`) are coerced to 500 with a
 * generic message — never leak stack traces or driver errors to the client.
 * The full error is logged at `error` level for observability.
 *
 * Production scrubbing:
 *   - In production, HTTP error messages from non-validation paths are
 *     replaced with a generic per-status string ('Unauthorized', 'Forbidden',
 *     etc). The internal message is still emitted to the logs at `warn`
 *     level so operators can debug without exposing implementation details
 *     (e.g. 'refresh token invalid, expired, or revoked' — which leaks the
 *     internal token state machine — becomes plain 'Unauthorized').
 *   - ValidationPipe responses (400 with `message: string[]`) are PRESERVED
 *     so the client still gets actionable per-field feedback. Validation
 *     output is bounded by class-validator messages we author — no DB
 *     internals can leak through it.
 *   - Internal 500s already get a generic 'Internal server error' regardless
 *     of NODE_ENV.
 */

/**
 * Generic message for each HTTP status we explicitly handle. Anything not
 * listed falls back to the per-status RFC reason phrase via `STATUS_FALLBACK`.
 */
const PROD_GENERIC_MESSAGES: Record<number, string> = {
  [HttpStatus.BAD_REQUEST]: 'Bad Request',
  [HttpStatus.UNAUTHORIZED]: 'Unauthorized',
  [HttpStatus.FORBIDDEN]: 'Forbidden',
  [HttpStatus.NOT_FOUND]: 'Not Found',
  [HttpStatus.CONFLICT]: 'Conflict',
  [HttpStatus.UNPROCESSABLE_ENTITY]: 'Unprocessable Entity',
  [HttpStatus.TOO_MANY_REQUESTS]: 'Too Many Requests',
  [HttpStatus.INTERNAL_SERVER_ERROR]: 'Internal server error',
  [HttpStatus.SERVICE_UNAVAILABLE]: 'Service Unavailable',
};

const STATUS_FALLBACK = 'Error';

@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  private readonly logger = new Logger(AllExceptionsFilter.name);

  catch(exception: unknown, host: ArgumentsHost): void {
    const ctx = host.switchToHttp();
    const response = ctx.getResponse<Response>();
    const request = ctx.getRequest<Request>();

    const isHttp = exception instanceof HttpException;
    const status = isHttp ? exception.getStatus() : HttpStatus.INTERNAL_SERVER_ERROR;
    const isProduction = process.env.NODE_ENV === 'production';

    let message: string | string[] = 'Internal server error';
    let error: string | undefined;
    let originalMessage: string | string[] | undefined;

    if (isHttp) {
      const body = exception.getResponse();
      if (typeof body === 'string') {
        message = body;
      } else if (typeof body === 'object' && body !== null) {
        const b = body as { message?: string | string[]; error?: string };
        if (b.message !== undefined) message = b.message;
        if (b.error !== undefined) error = b.error;
      }

      // Production scrub — see file-header comment for the rules. Validation
      // (BadRequestException with array `message`) is the one path we keep
      // verbatim because the array contents come from class-validator
      // messages we author and the client needs them to render per-field
      // errors.
      const isValidationFeedback =
        exception instanceof BadRequestException && Array.isArray(message);
      if (isProduction && !isValidationFeedback) {
        originalMessage = message;
        message = PROD_GENERIC_MESSAGES[status] ?? STATUS_FALLBACK;
      }
    }

    if (!isHttp) {
      this.logger.error(
        `Unhandled exception on ${request.method} ${request.url}`,
        exception instanceof Error ? exception.stack : String(exception),
      );
    } else if (originalMessage !== undefined) {
      // Keep the actionable detail in the logs for operators even though
      // we don't echo it back to the client.
      this.logger.warn(
        `[scrubbed] ${request.method} ${request.url} → ${status}: ${
          Array.isArray(originalMessage) ? originalMessage.join('; ') : originalMessage
        }`,
      );
    }

    response.status(status).json({
      statusCode: status,
      message,
      ...(error ? { error } : {}),
      path: request.url,
      timestamp: new Date().toISOString(),
    });
  }
}

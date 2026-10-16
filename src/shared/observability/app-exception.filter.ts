import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  HttpStatus,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaExceptionFilter } from '../prisma/prisma-exception.filter';
import { AppLogger } from './app-logger';
import { currentRequestId } from './request-context';
import {
  ObservedRequest,
  routeTemplate,
} from './request-observability.middleware';

interface FilterResponse {
  headersSent: boolean;
  status(code: number): { json(body: unknown): unknown };
}

/** Errores de `http-errors` (body-parser: 400 JSON inválido, 413...). */
interface HttpishError {
  statusCode: number;
  message: string;
}

const INTERNAL_ERROR = {
  statusCode: HttpStatus.INTERNAL_SERVER_ERROR,
  error: 'Internal Server Error',
  message: 'Ocurrió un error procesando la solicitud.',
};

function isHttpishError(value: unknown): value is HttpishError {
  if (!(value instanceof Error)) return false;
  const { statusCode } = value as Partial<HttpishError>;
  return (
    typeof statusCode === 'number' && statusCode >= 400 && statusCode < 600
  );
}

/**
 * Filtro global de la API (DX-023), instalado por applyObservability:
 *
 * - 4xx: misma respuesta que el filtro por defecto de Nest; no es un error
 *   del servidor y no se registra como tal.
 * - 5xx: se registra con su stack, el request id, el método y la ruta
 *   plantilla (nunca la URL, la query ni el cuerpo), y la respuesta solo
 *   añade el `requestId` para que soporte lo encuentre en el log: el stack y
 *   el mensaje de un error no controlado nunca salen al cliente.
 * - Prisma: lo resuelve PrismaExceptionFilter (409/400 o un 500 sin el
 *   DETAIL de Postgres), que también añade el request id a sus 500.
 */
@Catch()
export class AppExceptionFilter implements ExceptionFilter {
  constructor(
    private readonly logger: AppLogger,
    private readonly prismaFilter = new PrismaExceptionFilter(),
  ) {}

  catch(exception: unknown, host: ArgumentsHost): void {
    if (
      exception instanceof Prisma.PrismaClientKnownRequestError ||
      exception instanceof Prisma.PrismaClientUnknownRequestError
    ) {
      this.prismaFilter.catch(exception, host);
      return;
    }

    const http = host.switchToHttp();
    const req = http.getRequest<ObservedRequest>();
    const res = http.getResponse<FilterResponse>();
    const { status, body } = this.toResponse(exception);

    if (status >= 500) {
      this.logServerError(exception, req, status);
      const requestId = currentRequestId();
      if (requestId && body !== null && typeof body === 'object') {
        Object.assign(body, { requestId });
      }
    }
    if (res.headersSent) return;
    res.status(status).json(body);
  }

  private toResponse(exception: unknown): { status: number; body: object } {
    if (exception instanceof HttpException) {
      const status = exception.getStatus();
      const response = exception.getResponse();
      // Copia: el requestId no debe quedar pegado a la excepción.
      return {
        status,
        body:
          typeof response === 'string'
            ? { statusCode: status, message: response }
            : { ...response },
      };
    }
    if (isHttpishError(exception) && exception.statusCode < 500) {
      return {
        status: exception.statusCode,
        body: { statusCode: exception.statusCode, message: exception.message },
      };
    }
    return {
      status: HttpStatus.INTERNAL_SERVER_ERROR,
      body: { ...INTERNAL_ERROR },
    };
  }

  private logServerError(
    exception: unknown,
    req: ObservedRequest,
    status: number,
  ): void {
    const error = exception instanceof Error ? exception : undefined;
    const route = routeTemplate(req);
    this.logger.entry(
      'error',
      'ExceptionFilter',
      `${req.method} ${route ?? '-'} ${status}`,
      {
        method: req.method,
        route,
        status,
        error: error?.name ?? 'NonError',
      },
      error?.stack,
    );
  }
}

import {
  CallHandler,
  ExecutionContext,
  Injectable,
  NestInterceptor,
  UnauthorizedException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Observable, catchError, concatMap, from, throwError } from 'rxjs';
import { TenantContextService } from '../../../shared/tenancy/tenant-context.service';
import { currentRequestId } from '../../../shared/observability/request-context';
import { RecordAuditEventUseCase } from '../application/record-audit-event.use-case';
import type { AuditActorRef } from '../domain/audit-event';
import { AUDIT_OPTIONS, type AuditOptions } from './audit-options';
import {
  buildAuditDraft,
  isBreakGlassLogin,
  loginActor,
  type AuditedRequest,
  type AuditScope,
} from './audit-request';

/** `X-Result-Count` de la respuesta (búsquedas auditadas, DX-191). */
function resultCountOf(context: ExecutionContext): number | null {
  const res = context
    .switchToHttp()
    .getResponse<{ getHeader?: (name: string) => unknown }>();
  const raw = res.getHeader?.('x-result-count');
  const value = typeof raw === 'number' ? raw : Number(raw);
  return Number.isInteger(value) && value >= 0 ? value : null;
}

function headerValue(req: AuditedRequest, name: string): string | null {
  const value = req.headers[name];
  return (Array.isArray(value) ? value[0] : value) ?? null;
}

/**
 * Registra el evento de auditoría de un endpoint marcado con `@Audit(...)`
 * (DX-009). UN evento por petición, es decir, una sola escritura: una lectura
 * de la ficha que consulta varias tablas sigue siendo un VIEW.
 *
 * Cuándo: JUSTO DESPUÉS de que el handler terminó bien y ANTES de enviar la
 * respuesta (se espera a la escritura, así el orden es determinista). Una
 * petición que falla (404, 403, 400...) no deja evento: no accedió a nada.
 * La excepción es el login, que registra también el fallido (401).
 *
 * No va en la misma transacción que el cambio: los casos de uso abren la suya
 * y meterlo dentro obligaría a tocarlos todos. La escritura del evento nunca
 * rompe la petición (ver RecordAuditEventUseCase).
 *
 * Tenant, sede y request id se capturan al ENTRAR: el interceptor va a nivel
 * de método, así que corre dentro del contexto que abrió
 * TenantContextInterceptor (a nivel de clase).
 */
@Injectable()
export class AuditInterceptor implements NestInterceptor {
  constructor(
    private readonly reflector: Reflector,
    private readonly recorder: RecordAuditEventUseCase,
    private readonly tenantContext: TenantContextService,
  ) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const options = this.reflector.get<AuditOptions | undefined>(
      AUDIT_OPTIONS,
      context.getHandler(),
    );
    if (!options || context.getType() !== 'http') return next.handle();
    const req = context.switchToHttp().getRequest<AuditedRequest>();
    const tenantId =
      this.tenantContext.getTenantId() ?? req.tenantHost?.tenantId ?? null;
    // Sin clínica (login en el apex): auditoría de plataforma, fuera de alcance.
    if (!tenantId) return next.handle();
    const scope: AuditScope = {
      tenantId,
      locationId: this.tenantContext.getLocationId() ?? null,
      requestId: currentRequestId() ?? null,
    };
    if (options.action === 'LOGIN') return this.login(req, scope, next);
    return next.handle().pipe(
      concatMap(async (body: unknown) => {
        if (req.skipAudit) return body;
        const draft = buildAuditDraft(
          options,
          req,
          body,
          scope,
          options.search ? resultCountOf(context) : null,
        );
        if (draft) await this.recorder.record(draft);
        return body;
      }),
    );
  }

  /**
   * Login: el correcto con el usuario del token recién emitido (con
   * `reason: BREAK_GLASS` si es un acceso de soporte, SEC-008); el fallido
   * (solo 401, no un 400 de validación) con el email como pista para
   * resolver al miembro. Ni el email ni la contraseña se guardan.
   */
  private login(
    req: AuditedRequest,
    scope: AuditScope,
    next: CallHandler,
  ): Observable<unknown> {
    const record = (
      action: 'LOGIN' | 'LOGIN_FAILED',
      actor: AuditActorRef,
      breakGlass = false,
    ): Promise<void> =>
      this.recorder.record({
        tenantId: scope.tenantId,
        locationId: null,
        actor,
        action,
        resourceType: 'SESSION',
        resourceId: null,
        patient: null,
        requestId: scope.requestId,
        ip: req.ip ?? null,
        userAgent: headerValue(req, 'user-agent'),
        metadata:
          action === 'LOGIN_FAILED'
            ? { reason: 'INVALID_CREDENTIALS' }
            : breakGlass
              ? { reason: 'BREAK_GLASS' }
              : {},
      });
    return next.handle().pipe(
      concatMap(async (body: unknown) => {
        const actor = loginActor(body);
        // SEC-008: el acceso de soporte de un superadmin queda marcado.
        if (actor) await record('LOGIN', actor, isBreakGlassLogin(body));
        return body;
      }),
      catchError((err: unknown) => {
        if (!(err instanceof UnauthorizedException)) {
          return throwError(() => err);
        }
        const email =
          typeof req.body === 'object' &&
          req.body !== null &&
          'email' in req.body
            ? req.body.email
            : null;
        return from(
          record('LOGIN_FAILED', {
            kind: 'email',
            email: typeof email === 'string' ? email : '',
          }),
        ).pipe(concatMap(() => throwError(() => err)));
      }),
    );
  }
}

import {
  BadRequestException,
  CallHandler,
  ExecutionContext,
  Injectable,
  NestInterceptor,
  UnauthorizedException,
} from '@nestjs/common';
import { Observable } from 'rxjs';
import { isTenantPayload } from '../crypto/token.service';
import { TenantContextService } from './tenant-context.service';
import { TenantHostRequest } from './tenant-host-request';
import { PrismaService } from '../prisma/prisma.service';

@Injectable()
export class TenantContextInterceptor implements NestInterceptor {
  constructor(
    private readonly tenantContext: TenantContextService,
    private readonly prisma: PrismaService,
  ) {}

  /**
   * Sede activa del request: cabecera `X-Location-Id`, VALIDADA contra el
   * tenant del host. Una sede de otra clínica no se ignora en silencio (eso
   * devolvería datos de la sede equivocada sin avisar): se rechaza.
   * Sin cabecera → `undefined` → vista consolidada de toda la clínica.
   */
  private async resolveLocationId(
    req: TenantHostRequest,
    tenantId: string,
  ): Promise<string | undefined> {
    const raw = req.headers?.['x-location-id'] ?? undefined;
    const locationId = Array.isArray(raw) ? raw[0] : raw;
    if (!locationId) return undefined;
    const location = await this.prisma.runWithTenant(tenantId, (tx) =>
      tx.location.findFirst({
        where: { id: locationId, deletedAt: null },
        select: { id: true },
      }),
    );
    if (!location) {
      throw new BadRequestException('Unknown location for this clinic');
    }
    return location.id;
  }

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const req = context.switchToHttp().getRequest<TenantHostRequest>();
    // The host is the authority for the active tenant.
    const hostTenantId = req.tenantHost?.tenantId;
    if (!hostTenantId) {
      throw new UnauthorizedException('No tenant in context');
    }
    // A token issued for another tenant must not be usable on this host. A
    // PLATFORM token (superadmin, no tenant) is likewise rejected here: it is
    // only valid on /platform/* routes, never inside a clinic — to operate a
    // clinic the superadmin logs in on that clinic's host and gets a normal
    // tenant token (see LoginUseCase).
    if (
      req.user &&
      (!isTenantPayload(req.user) || req.user.tenantId !== hostTenantId)
    ) {
      throw new UnauthorizedException('Tenant mismatch');
    }
    // run() keeps the ALS store active through the handler's async execution,
    // because we subscribe to next.handle() INSIDE the run callback (enterWith
    // in a guard does not survive the guard->handler async boundary).
    return new Observable((subscriber) => {
      // La validación de la sede es asíncrona (consulta la DB), así que se
      // resuelve ANTES de abrir el store: así el handler ya corre con la sede
      // definitiva y nunca con una a medio validar.
      this.resolveLocationId(req, hostTenantId)
        .then((locationId) => {
          this.tenantContext.run(hostTenantId, locationId, () => {
            next.handle().subscribe(subscriber);
          });
        })
        .catch((err) => subscriber.error(err));
    });
  }
}

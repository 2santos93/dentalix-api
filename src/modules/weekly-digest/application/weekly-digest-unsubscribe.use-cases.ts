import { Inject, Injectable, NotFoundException } from '@nestjs/common';
import {
  hashPublicLinkToken,
  isWellFormedPublicLinkToken,
} from '../../../shared/public-links/public-link-token';
import { TenantContextService } from '../../../shared/tenancy/tenant-context.service';
import type { AuditRequestMeta } from '../../audit/domain/audit-request-context';
import {
  WEEKLY_DIGEST_CLOCK,
  WEEKLY_DIGEST_REPOSITORY,
  type DigestUnsubscribeLink,
  type WeeklyDigestClock,
  type WeeklyDigestRepository,
} from '../domain/ports/weekly-digest-repository.port';

export const WEEKLY_DIGEST_LINK_NOT_FOUND_MESSAGE =
  'El enlace para dejar de recibir el resumen no existe o caducó.';

/**
 * Lo que ve quien abre `/resumen/baja/<token>`: la clínica y si sigue
 * recibiendo el resumen. Nada más (ni su nombre ni su correo).
 */
export interface PublicWeeklyDigestUnsubscribeView {
  clinicName: string;
  /** ACTIVE: lo sigue recibiendo. ALREADY_OUT: ya no. */
  status: 'ACTIVE' | 'ALREADY_OUT';
}

/**
 * Búsqueda común de GET y POST públicos (patrón de la baja de DX-128): el
 * tenant sale SOLO del host; sin él, o con un token que no puede ser nuestro,
 * 404 sin consultar. La RLS hace invisible un enlace de otra clínica (→ el
 * mismo 404 que uno inventado). Un enlace caducado (60 días), también.
 */
async function findLink(
  tenantContext: TenantContextService,
  repo: WeeklyDigestRepository,
  token: string,
  at: Date,
): Promise<{ link: DigestUnsubscribeLink; clinicName: string }> {
  if (!tenantContext.getTenantId() || !isWellFormedPublicLinkToken(token)) {
    throw new NotFoundException(WEEKLY_DIGEST_LINK_NOT_FOUND_MESSAGE);
  }
  const link = await repo.findUnsubscribeLink(hashPublicLinkToken(token), at);
  const clinicName = link ? await repo.clinicName() : null;
  if (!link || clinicName === null) {
    throw new NotFoundException(WEEKLY_DIGEST_LINK_NOT_FOUND_MESSAGE);
  }
  return { link, clinicName };
}

/**
 * PÚBLICO, solo lectura: abrir el enlace no da de baja (los antivirus y los
 * previsualizadores de correo abren los enlaces solos). La baja exige el POST
 * del botón de la página.
 */
@Injectable()
export class GetPublicWeeklyDigestUnsubscribeUseCase {
  constructor(
    private readonly tenantContext: TenantContextService,
    @Inject(WEEKLY_DIGEST_REPOSITORY)
    private readonly repo: WeeklyDigestRepository,
    @Inject(WEEKLY_DIGEST_CLOCK) private readonly clock: WeeklyDigestClock,
  ) {}

  async execute(token: string): Promise<PublicWeeklyDigestUnsubscribeView> {
    const { link, clinicName } = await findLink(
      this.tenantContext,
      this.repo,
      token,
      this.clock(),
    );
    return { clinicName, status: link.subscribed ? 'ACTIVE' : 'ALREADY_OUT' };
  }
}

/**
 * PÚBLICO: el destinatario deja de recibir el resumen desde el enlace del
 * email (D7). Idempotente: repetirlo (o hacerlo tras quitarse en Ajustes)
 * responde lo mismo sin escribir ni auditar otra vez. Lo vuelve a recibir si
 * un ADMIN lo marca de nuevo en Ajustes.
 */
@Injectable()
export class ConfirmPublicWeeklyDigestUnsubscribeUseCase {
  constructor(
    private readonly tenantContext: TenantContextService,
    @Inject(WEEKLY_DIGEST_REPOSITORY)
    private readonly repo: WeeklyDigestRepository,
    @Inject(WEEKLY_DIGEST_CLOCK) private readonly clock: WeeklyDigestClock,
  ) {}

  async execute(
    token: string,
    meta: AuditRequestMeta,
  ): Promise<PublicWeeklyDigestUnsubscribeView> {
    const now = this.clock();
    const { link, clinicName } = await findLink(
      this.tenantContext,
      this.repo,
      token,
      now,
    );
    const done = await this.repo.unsubscribe(link.deliveryId, now, meta);
    if (done === null) {
      throw new NotFoundException(WEEKLY_DIGEST_LINK_NOT_FOUND_MESSAGE);
    }
    return { clinicName, status: 'ALREADY_OUT' };
  }
}

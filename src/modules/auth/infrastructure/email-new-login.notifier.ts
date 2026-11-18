import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../../shared/prisma/prisma.service';
import { TenantLinkBaseService } from '../../../shared/tenancy/tenant-link-base.service';
import { locationRegionalOrNull } from '../../../shared/locations/location-regional';
import { regionalFormat } from '../../../shared/format/regional-format';
import { EmailOutbox } from '../../notifications/email/application/email-outbox.service';
import { SESSION_ALERT_PATH } from '../domain/user-sessions';
import type {
  NewLoginNotice,
  NewLoginNotifier,
} from '../domain/ports/new-login-notifier.port';

/**
 * DX-137: el aviso de inicio de sesión nuevo sobre el email transaccional.
 * Firma la clínica (su marca) y el enlace va a su host. La hora, en la zona y
 * el formato de su sede principal (la primera que se creó); sin ellos, el
 * email sale sin hora. Un aviso de seguridad no pasa por los topes
 * anti-abuso (como `mfa-notice`).
 */
@Injectable()
export class EmailNewLoginNotifier implements NewLoginNotifier {
  constructor(
    private readonly outbox: EmailOutbox,
    private readonly prisma: PrismaService,
    private readonly links: TenantLinkBaseService,
  ) {}

  async send(notice: NewLoginNotice): Promise<void> {
    const base = await this.links.forTenant(notice.tenantId);
    if (!base) return;
    const clinic = await this.clinic(notice.tenantId);
    if (!clinic) return;
    await this.outbox.enqueue({
      tenantId: notice.tenantId,
      to: notice.to,
      template: 'new-login',
      referenceId: notice.userId,
      locale: 'es',
      vars: {
        userName: notice.userName,
        clinicName: clinic.name,
        deviceLabel: notice.deviceLabel,
        ipPrefix: notice.ipPrefix,
        whenLabel: clinic.region
          ? regionalFormat(clinic.region).longDateTime(
              notice.at,
              clinic.region.timeZone,
            )
          : null,
        notMeUrl: `${base}${SESSION_ALERT_PATH}/${notice.token}`,
        expiresInHours: notice.expiresInHours,
      },
    });
  }

  private async clinic(tenantId: string) {
    return this.prisma.runWithTenant(tenantId, async (tx) => {
      const tenant = await tx.tenant.findFirst({
        where: { id: tenantId, deletedAt: null },
        select: { name: true },
      });
      if (!tenant) return null;
      const location = await tx.location.findFirst({
        where: { tenantId, deletedAt: null },
        orderBy: { createdAt: 'asc' },
        select: { timeZone: true, locale: true, hourCycle: true },
      });
      return { name: tenant.name, region: locationRegionalOrNull(location) };
    });
  }
}

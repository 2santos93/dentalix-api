import { Inject, Injectable } from '@nestjs/common';
import type { RegionalFormat } from '../../../shared/format/regional-format';
import { requireLocationFormat } from '../../../shared/locations/location-regional';
import { TenantContextService } from '../../../shared/tenancy/tenant-context.service';
import { TenantLinkBaseService } from '../../../shared/tenancy/tenant-link-base.service';
import {
  WEEKLY_DIGEST_REPOSITORY,
  type DigestClinic,
  type WeeklyDigestRepository,
} from '../domain/ports/weekly-digest-repository.port';
import {
  composeWeeklyDigest,
  type WeeklyDigest,
} from '../domain/weekly-digest';
import { weekBefore, type DigestWeek } from '../domain/weekly-digest-schedule';
import { WeeklyDigestSources } from './weekly-digest-sources';

/**
 * ¿La sede principal tiene zona Y formato? (revisión DX-568, n.º 2) Sin
 * formato no hay email que escribir: el barrido salta la clínica y Ajustes
 * avisa con `PRINCIPAL_LOCATION_UNCONFIGURED`.
 */
export function isPrincipalConfigured(clinic: DigestClinic | null): boolean {
  if (!clinic) return false;
  try {
    requireLocationFormat(clinic.principal);
    return true;
  } catch {
    return false;
  }
}

/** Lo que hace falta para escribir el email de una clínica. */
export interface ComposedDigest {
  digest: WeeklyDigest;
  clinicName: string;
  fmt: RegionalFormat;
  /** `<protocolo>://<host de la clínica>`; null = sin enlaces. */
  linkBase: string | null;
}

/**
 * Arma el resumen de una semana para la clínica del contexto (DX-568): lee
 * las fuentes, compara el saldo vencido con la foto del envío de la semana
 * anterior y resuelve el formato de la sede principal y el host de los
 * enlaces. Lo usan el trabajo semanal y la prueba de Ajustes.
 */
@Injectable()
export class WeeklyDigestComposer {
  constructor(
    @Inject(WEEKLY_DIGEST_REPOSITORY)
    private readonly repo: WeeklyDigestRepository,
    private readonly sources: WeeklyDigestSources,
    private readonly links: TenantLinkBaseService,
    private readonly tenantContext: TenantContextService,
  ) {}

  async compose(
    clinic: DigestClinic,
    week: DigestWeek,
  ): Promise<ComposedDigest> {
    const tenantId = this.tenantContext.getTenantId();
    if (!tenantId) throw new Error('No tenant in context');
    // El formato antes que nada: sin él (sede sin configurar) no hay email.
    const fmt = requireLocationFormat(clinic.principal);
    const locations = await this.repo.activeLocations();
    const sources = await this.sources.read(tenantId, week, locations);
    const previousSnapshot = await this.repo.snapshotOf(
      weekBefore(week).weekStart,
    );
    return {
      digest: composeWeeklyDigest(sources, previousSnapshot),
      clinicName: clinic.name,
      fmt,
      linkBase: await this.links.forTenant(tenantId),
    };
  }
}

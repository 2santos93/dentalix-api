import { createHash } from 'node:crypto';
import { Inject, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { PrescriptionStatus } from '@prisma/client';
import { TenantContextService } from '../../../../shared/tenancy/tenant-context.service';
import { TenantLinkBaseService } from '../../../../shared/tenancy/tenant-link-base.service';
import type { AuditRequestMeta } from '../../../audit/domain/audit-request-context';
import type { PrescriptionLocationFormat } from '../../domain/entities/prescription.entity';
import {
  PRESCRIPTION_REPOSITORY,
  type PrescriptionRepository,
} from '../../domain/ports/prescription-repository.port';
import { expectedPrescriptionHash } from '../../domain/prescription-hash';
import {
  normalizePrescriptionVerificationCode,
  patientInitials,
  prescriptionVerificationUrl,
  type PublicVerificationState,
} from '../../domain/prescription-verification';

/**
 * El mismo 404 para un código malformado, inexistente, de otra clínica o sin
 * clínica en el host: la respuesta no dice cuál de ellos es (sin enumeración).
 */
export const PRESCRIPTION_VERIFICATION_NOT_FOUND_MESSAGE =
  'No encontramos ninguna receta con este código.';

/**
 * Lo que ve quien verifica (DX-467). Siempre la misma forma; cada estado
 * rellena solo lo suyo y el resto va a `null`:
 * - VALID: fecha de emisión, profesional y su registro, clínica e iniciales
 *   del paciente (lo que dice la receta impresa, nunca lo clínico);
 * - VOIDED: solo cuándo se anuló (sin motivo ni quién);
 * - UNVERIFIABLE: nada (el hash guardado no casa con el recalculado).
 * `regional`: el formato ACTUAL de la sede de la receta, para pintar la fecha
 * como en la receta impresa (nunca el del navegador). Solo cuando hay fecha
 * que pintar (VALID y VOIDED); en UNVERIFIABLE, `null`.
 */
export interface PublicPrescriptionVerification {
  state: PublicVerificationState;
  issuedAt: Date | null;
  voidedAt: Date | null;
  professionalName: string | null;
  professionalLicense: string | null;
  clinicName: string | null;
  patientInitials: string | null;
  regional: PrescriptionLocationFormat | null;
}

/** Por qué un 404 de la verificación pública (solo para el log). */
type NotFoundReason = 'NO_TENANT' | 'MALFORMED' | 'UNKNOWN';

/**
 * Seudónimo estable de la IP para el log: correlaciona un barrido de códigos
 * desde una misma IP sin escribirla en claro. No es anonimización (una IPv4 se
 * puede recuperar por fuerza bruta): el log es de acceso restringido, como la
 * auditoría.
 */
export function verificationIpHash(ip: string | null): string | null {
  if (!ip) return null;
  return createHash('sha256')
    .update(`dentalix:prescription-verify-ip:${ip}`)
    .digest('hex')
    .slice(0, 16);
}

const EMPTY = {
  issuedAt: null,
  voidedAt: null,
  professionalName: null,
  professionalLicense: null,
  clinicName: null,
  patientInitials: null,
} as const;

/**
 * PÚBLICO (DX-467): la farmacia (o quien tenga la receta) comprueba con el
 * código impreso si la receta es auténtica y sigue vigente. El tenant sale
 * SOLO del host; la RLS hace invisible el código de otra clínica. Cada
 * verificación de una receta encontrada queda auditada (solo ids, con su
 * resultado); un 404 no deja rastro: no hay receta a la que atarlo.
 */
@Injectable()
export class VerifyPrescriptionUseCase {
  private readonly logger = new Logger('PrescriptionVerification');

  constructor(
    private readonly tenantContext: TenantContextService,
    @Inject(PRESCRIPTION_REPOSITORY)
    private readonly repo: PrescriptionRepository,
  ) {}

  async execute(
    rawCode: string,
    meta: AuditRequestMeta,
  ): Promise<PublicPrescriptionVerification> {
    const tenantId = this.tenantContext.getTenantId() ?? null;
    const code = normalizePrescriptionVerificationCode(rawCode);
    // Sin clínica en el host o sin forma de código: 404 sin tocar la base.
    if (!tenantId) throw this.notFound('NO_TENANT', null, meta);
    if (code === null) throw this.notFound('MALFORMED', tenantId, meta);
    const rx = await this.repo.findByVerificationCode(code);
    if (!rx) throw this.notFound('UNKNOWN', tenantId, meta);
    // La integridad va primero: una receta alterada no se da por válida ni
    // por anulada. Una fila que no se puede sellar con su formato tampoco.
    const state: PublicVerificationState =
      expectedPrescriptionHash(rx) !== rx.contentHash
        ? 'UNVERIFIABLE'
        : rx.status === PrescriptionStatus.VOIDED
          ? 'VOIDED'
          : 'VALID';
    await this.repo.recordPublicVerification({
      prescriptionId: rx.id,
      patientId: rx.patientId,
      locationId: rx.locationId,
      state,
      meta,
    });
    const regional = rx.locationFormat;
    switch (state) {
      case 'VALID':
        return {
          ...EMPTY,
          state,
          issuedAt: rx.issuedAt,
          professionalName: rx.professionalName,
          professionalLicense: rx.professionalLicense,
          clinicName: rx.clinicName,
          patientInitials: patientInitials(rx.patientName),
          regional,
        };
      case 'VOIDED':
        return { ...EMPTY, state, voidedAt: rx.voidedAt, regional };
      case 'UNVERIFIABLE':
        return { ...EMPTY, state, regional: null };
    }
  }

  /**
   * El 404 genérico, y un evento de log para detectar barridos de códigos:
   * motivo, clínica del host, request id y un hash de la IP; nunca el código
   * probado ni la IP. No va a la auditoría de la BD (README, DX-467).
   */
  private notFound(
    reason: NotFoundReason,
    tenantId: string | null,
    meta: AuditRequestMeta,
  ): NotFoundException {
    this.logger.warn({
      event: 'prescription_verification.not_found',
      reason,
      tenantId,
      requestId: meta.requestId,
      ipHash: verificationIpHash(meta.ip),
    });
    return new NotFoundException(PRESCRIPTION_VERIFICATION_NOT_FOUND_MESSAGE);
  }
}

/**
 * DX-467: la URL que va en el QR de la receta impresa: la página pública
 * `/receta/<código>` en el host de plataforma de la clínica (el de la
 * petición si es de plataforma; si no, `<subdominio>.<dominio base>`), nunca
 * un dominio personalizado: el papel dura años y ese DNS lo controla un
 * tercero (TenantLinkBaseService, SEC-033). `null` si no hay host seguro: la
 * receta imprime el código sin QR.
 */
@Injectable()
export class PrescriptionVerificationLinks {
  constructor(
    @Inject(TenantLinkBaseService)
    private readonly linkBase: Pick<TenantLinkBaseService, 'forTenant'>,
    @Inject(TenantContextService)
    private readonly tenantContext: Pick<TenantContextService, 'getTenantId'>,
  ) {}

  async urlFor(code: string, requestHost?: string): Promise<string | null> {
    const tenantId = this.tenantContext.getTenantId();
    if (!tenantId) return null;
    const base = await this.linkBase.forTenant(tenantId, requestHost);
    return base ? prescriptionVerificationUrl(base, code) : null;
  }
}

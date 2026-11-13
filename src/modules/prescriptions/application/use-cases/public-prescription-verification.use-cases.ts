import { Inject, Injectable, NotFoundException } from '@nestjs/common';
import { TenantContextService } from '../../../../shared/tenancy/tenant-context.service';
import type { AuditRequestMeta } from '../../../audit/domain/audit-request-context';
import { expectedPrescriptionHash } from '../../domain/prescription-hash';
import {
  type PrescriptionVerification,
  verifyPrescription,
} from '../../domain/prescription-verification';
import { normalizePrescriptionVerificationCode } from '../../domain/prescription-verification-code';
import {
  PRESCRIPTION_REPOSITORY,
  type PrescriptionRepository,
} from '../../domain/ports/prescription-repository.port';
import { PRESCRIPTION_NOT_FOUND_MESSAGE } from './prescriptions.use-cases';

/**
 * DX-467: la página pública `/receta/<código>` pregunta aquí si una receta
 * vale. Sin sesión: la clínica sale SOLO del host
 * (`PublicTenantContextInterceptor`) y la lectura va bajo su RLS.
 *
 * Sin enumeración: host sin clínica, código mal formado, código que no existe
 * y código de OTRA clínica dan el mismo 404 genérico (mismo mensaje y forma
 * que cualquier receta no encontrada), y los dos primeros ni consultan la
 * base. Se audita cada consulta de una receta encontrada
 * (`PRESCRIPTION_VERIFIED`) y, aparte, la que encuentra el hash alterado
 * (`PRESCRIPTION_INTEGRITY_MISMATCH`), que la página muestra como «No se
 * puede verificar».
 */
@Injectable()
export class VerifyPublicPrescriptionUseCase {
  constructor(
    @Inject(PRESCRIPTION_REPOSITORY)
    private readonly repo: PrescriptionRepository,
    private readonly tenantContext: TenantContextService,
  ) {}

  async execute(
    rawCode: string,
    meta: AuditRequestMeta,
  ): Promise<PrescriptionVerification> {
    const code = normalizePrescriptionVerificationCode(rawCode);
    if (!this.tenantContext.getTenantId() || code === null) {
      throw new NotFoundException(PRESCRIPTION_NOT_FOUND_MESSAGE);
    }
    const rx = await this.repo.findByVerificationCode(code);
    if (!rx) {
      throw new NotFoundException(PRESCRIPTION_NOT_FOUND_MESSAGE);
    }
    // Una fila que ni se puede sellar con su formato tampoco valida (null).
    const integrityOk = expectedPrescriptionHash(rx) === rx.contentHash;
    await this.repo.recordPublicVerification({
      prescriptionId: rx.id,
      locationId: rx.locationId,
      reason: integrityOk
        ? 'PRESCRIPTION_VERIFIED'
        : 'PRESCRIPTION_INTEGRITY_MISMATCH',
      meta,
    });
    return verifyPrescription(rx, integrityOk);
  }
}

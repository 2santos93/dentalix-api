import { NotFoundException } from '@nestjs/common';
import { PrescriptionStatus } from '@prisma/client';
import { TenantContextService } from '../../../../shared/tenancy/tenant-context.service';
import { FixedDocumentTypeNamesReader } from '../../../document-type-names/__fixtures__/fixed-document-type-names.reader';
import {
  DENTIST_ID,
  InMemoryPrescriptionRepository,
  PATIENT_ID,
  TENANT_ID,
} from '../__fixtures__/in-memory-prescriptions';
import { formatPrescriptionVerificationCode } from '../../domain/prescription-verification-code';
import {
  IssuePrescriptionUseCase,
  PRESCRIPTION_NOT_FOUND_MESSAGE,
} from './prescriptions.use-cases';
import { VerifyPublicPrescriptionUseCase } from './public-prescription-verification.use-cases';

const NOW = new Date('2026-10-16T15:00:00.000Z');
const META = { requestId: 'req-1', ip: '203.0.113.9', userAgent: 'jest' };

describe('VerifyPublicPrescriptionUseCase (DX-467)', () => {
  let repo: InMemoryPrescriptionRepository;
  let tenantContext: TenantContextService;
  let useCase: VerifyPublicPrescriptionUseCase;
  let code: string;
  let id: string;

  beforeEach(async () => {
    repo = new InMemoryPrescriptionRepository();
    tenantContext = new TenantContextService();
    useCase = new VerifyPublicPrescriptionUseCase(repo, tenantContext);
    const rx = await new IssuePrescriptionUseCase(
      repo,
      () => NOW,
      new FixedDocumentTypeNamesReader(),
    ).execute(
      PATIENT_ID,
      {
        items: [
          {
            activeIngredient: 'Amoxicilina',
            concentration: '500 mg',
            pharmaceuticalForm: 'Cápsula',
            route: 'Oral',
            dose: '1 cápsula',
            frequency: 'Cada 8 horas',
            durationDays: 7,
            totalQuantity: 21,
            quantityUnit: 'cápsulas',
          },
        ],
      },
      DENTIST_ID,
    );
    code = rx.verificationCode;
    id = rx.id;
    repo.locationFormats.set(rx.locationId, {
      timeZone: 'America/Caracas',
      locale: 'es-VE',
      hourCycle: null,
    });
  });

  const verify = (raw: string) =>
    tenantContext.run(TENANT_ID, () => useCase.execute(raw, META));

  it('la receta emitida lleva un código con la forma pública', () => {
    expect(code).toMatch(/^[2-9A-HJKMNP-Z]{12}$/);
  });

  it('válida: solo los datos mínimos, y audita PRESCRIPTION_VERIFIED', async () => {
    await expect(verify(code)).resolves.toEqual({
      status: 'VALID',
      issuedOn: '2026-10-16',
      professionalName: 'Dra. Laura Ruiz',
      professionalLicense: 'RM-12345',
      clinicName: 'Clínica Demo',
      patientInitials: 'A. P. G.',
      locale: 'es-VE',
    });
    expect(repo.publicVerifications).toEqual([
      {
        prescriptionId: id,
        locationId: repo.rows[0].locationId,
        reason: 'PRESCRIPTION_VERIFIED',
        meta: META,
      },
    ]);
  });

  it('acepta el código agrupado e impreso en minúsculas', async () => {
    const grouped = formatPrescriptionVerificationCode(code).toLowerCase();
    await expect(verify(grouped)).resolves.toMatchObject({ status: 'VALID' });
  });

  it('anulada: solo el día de la anulación', async () => {
    const row = repo.rows[0];
    row.status = PrescriptionStatus.VOIDED;
    row.voidedAt = new Date('2026-10-20T02:00:00.000Z');
    row.voidReason = 'Dosis equivocada';
    await expect(verify(code)).resolves.toEqual({
      status: 'VOIDED',
      voidedOn: '2026-10-19',
      locale: 'es-VE',
    });
  });

  it('hash alterado: no se puede verificar y audita PRESCRIPTION_INTEGRITY_MISMATCH', async () => {
    repo.rows[0].patientName = 'Otra Persona';
    await expect(verify(code)).resolves.toEqual({ status: 'UNVERIFIABLE' });
    expect(repo.publicVerifications.map((v) => v.reason)).toEqual([
      'PRESCRIPTION_INTEGRITY_MISMATCH',
    ]);
  });

  it.each([
    ['inexistente', 'ABCDEFGHJKMN'],
    ['mal formado', 'no-es-un-codigo'],
    ['un uuid', '3f1c2a9e-5b7d-4c1a-9f2e-8d6b4a3c2e1f'],
  ])('%s: el mismo 404 genérico, sin auditar', async (_label, raw) => {
    const err = await verify(raw).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(NotFoundException);
    expect((err as NotFoundException).message).toBe(
      PRESCRIPTION_NOT_FOUND_MESSAGE,
    );
    expect(repo.publicVerifications).toEqual([]);
  });

  it('sin clínica en el host: 404 sin consultar', async () => {
    const spy = jest.spyOn(repo, 'findByVerificationCode');
    await expect(useCase.execute(code, META)).rejects.toBeInstanceOf(
      NotFoundException,
    );
    expect(spy).not.toHaveBeenCalled();
  });
});

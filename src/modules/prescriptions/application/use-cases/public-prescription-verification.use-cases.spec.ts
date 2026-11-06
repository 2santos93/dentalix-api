import { Logger, NotFoundException } from '@nestjs/common';
import { PrescriptionStatus } from '@prisma/client';
import type { TenantContextService } from '../../../../shared/tenancy/tenant-context.service';
import type { AuditRequestMeta } from '../../../audit/domain/audit-request-context';
import { FixedDocumentTypeNamesReader } from '../../../document-type-names/__fixtures__/fixed-document-type-names.reader';
import {
  DENTIST_ID,
  InMemoryPrescriptionRepository,
  PATIENT_ID,
} from '../__fixtures__/in-memory-prescriptions';
import { isPrescriptionVerificationCode } from '../../domain/prescription-verification';
import { IssuePrescriptionUseCase } from './prescriptions.use-cases';
import {
  PRESCRIPTION_VERIFICATION_NOT_FOUND_MESSAGE,
  PrescriptionVerificationLinks,
  VerifyPrescriptionUseCase,
} from './public-prescription-verification.use-cases';

const NOW = new Date('2026-10-16T15:00:00.000Z');
const META: AuditRequestMeta = {
  requestId: 'req-1',
  ip: '203.0.113.9',
  userAgent: 'Farmacia/1.0',
};

function setup({ withTenant = true } = {}) {
  const repo = new InMemoryPrescriptionRepository();
  repo.locationFormats.set(repo.issuer.location.id, {
    timeZone: 'America/Caracas',
    locale: 'es-VE',
    hourCycle: 'h23',
  });
  const tenantContext = {
    getTenantId: () => (withTenant ? 't1' : undefined),
  } as unknown as TenantContextService;
  const issue = new IssuePrescriptionUseCase(
    repo,
    () => NOW,
    new FixedDocumentTypeNamesReader(),
  );
  return {
    repo,
    verify: new VerifyPrescriptionUseCase(tenantContext, repo),
    issue: () =>
      issue.execute(
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
          notes: 'Tomar con comida',
        },
        DENTIST_ID,
      ),
  };
}

describe('VerifyPrescriptionUseCase (DX-467)', () => {
  it('toda receta emitida lleva un código de verificación propio', async () => {
    const { issue } = setup();
    const a = await issue();
    const b = await issue();
    expect(isPrescriptionVerificationCode(a.verificationCode)).toBe(true);
    expect(a.verificationCode).not.toBe(b.verificationCode);
  });

  it('vigente: «válida» con fecha, profesional y registro, clínica e iniciales; nada clínico', async () => {
    const { issue, verify } = setup();
    const rx = await issue();
    const view = await verify.execute(rx.verificationCode, META);
    expect(view).toEqual({
      state: 'VALID',
      issuedAt: NOW,
      voidedAt: null,
      professionalName: 'Dra. Laura Ruiz',
      professionalLicense: 'RM-12345',
      clinicName: 'Clínica Demo',
      patientInitials: 'A. P. G.',
      regional: {
        timeZone: 'America/Caracas',
        locale: 'es-VE',
        hourCycle: 'h23',
      },
    });
    const text = JSON.stringify(view);
    for (const leak of [
      'Amoxicilina',
      'Tomar con comida',
      '1020304050',
      'Pérez',
      rx.id,
      rx.patientId,
      rx.contentHash,
    ]) {
      expect(text).not.toContain(leak);
    }
  });

  it('acepta el código como se imprime (agrupado) o en minúsculas', async () => {
    const { issue, verify } = setup();
    const { verificationCode: code } = await issue();
    const grouped = `${code.slice(0, 4)}-${code.slice(4, 8)}-${code.slice(8)}`;
    await expect(
      verify.execute(grouped.toLowerCase(), META),
    ).resolves.toMatchObject({ state: 'VALID' });
  });

  it('anulada: solo «anulada» y cuándo, sin motivo ni quién ni el resto', async () => {
    const { issue, verify, repo } = setup();
    const rx = await issue();
    const voidedAt = new Date('2026-10-20T13:00:00.000Z');
    await repo.void(rx.id, {
      voidedById: DENTIST_ID,
      voidedAt,
      reason: 'Dosis equivocada',
    });
    const view = await verify.execute(rx.verificationCode, META);
    expect(view).toEqual({
      state: 'VOIDED',
      issuedAt: null,
      voidedAt,
      professionalName: null,
      professionalLicense: null,
      clinicName: null,
      patientInitials: null,
      regional: {
        timeZone: 'America/Caracas',
        locale: 'es-VE',
        hourCycle: 'h23',
      },
    });
    expect(JSON.stringify(view)).not.toContain('Dosis equivocada');
  });

  it('hash que no casa: «no se puede verificar», sin ningún dato, y queda auditado', async () => {
    const { issue, verify, repo } = setup();
    const rx = await issue();
    repo.rows[0].items[0].totalQuantity = 99;
    const view = await verify.execute(rx.verificationCode, META);
    // Sin fecha que pintar, tampoco el formato de la sede.
    expect(view).toEqual({
      state: 'UNVERIFIABLE',
      issuedAt: null,
      voidedAt: null,
      professionalName: null,
      professionalLicense: null,
      clinicName: null,
      patientInitials: null,
      regional: null,
    });
    expect(repo.publicVerifications).toEqual([
      {
        prescriptionId: rx.id,
        patientId: rx.patientId,
        locationId: rx.locationId,
        state: 'UNVERIFIABLE',
        meta: META,
      },
    ]);
  });

  it('una anulada cuyo hash no casa tampoco se puede verificar (la integridad va primero)', async () => {
    const { issue, verify, repo } = setup();
    const rx = await issue();
    await repo.void(rx.id, {
      voidedById: DENTIST_ID,
      voidedAt: new Date('2026-10-20T13:00:00.000Z'),
      reason: 'x',
    });
    repo.rows[0].professionalLicense = 'RM-99999';
    await expect(
      verify.execute(rx.verificationCode, META),
    ).resolves.toMatchObject({ state: 'UNVERIFIABLE' });
  });

  it('cada verificación queda auditada con su resultado y los datos de la petición', async () => {
    const { issue, verify, repo } = setup();
    const rx = await issue();
    await verify.execute(rx.verificationCode, META);
    await repo.void(rx.id, {
      voidedById: DENTIST_ID,
      voidedAt: new Date('2026-10-20T13:00:00.000Z'),
      reason: 'x',
    });
    await verify.execute(rx.verificationCode, META);
    expect(repo.publicVerifications.map((v) => v.state)).toEqual([
      'VALID',
      'VOIDED',
    ]);
    expect(repo.rows[0].status).toBe(PrescriptionStatus.VOIDED);
  });

  it('inexistente, malformado o sin clínica en el host: el mismo 404 genérico y nada auditado', async () => {
    const { issue, verify, repo } = setup();
    const rx = await issue();
    const noTenant = setup({ withTenant: false });
    noTenant.repo.rows = repo.rows;
    const attempts = [
      () => verify.execute('ZZZZZZZZZZZZ', META),
      () => verify.execute('no-es-un-codigo', META),
      () => verify.execute(rx.id, META),
      () => verify.execute('', META),
      () => noTenant.verify.execute(rx.verificationCode, META),
    ];
    for (const attempt of attempts) {
      const err = await attempt().then(
        () => null,
        (e: unknown) => e,
      );
      expect(err).toBeInstanceOf(NotFoundException);
      expect((err as NotFoundException).getResponse()).toEqual(
        new NotFoundException(
          PRESCRIPTION_VERIFICATION_NOT_FOUND_MESSAGE,
        ).getResponse(),
      );
    }
    expect(repo.publicVerifications).toEqual([]);
    expect(noTenant.repo.publicVerifications).toEqual([]);
  });
});

describe('VerifyPrescriptionUseCase · rastro de los 404 en el log (DX-467)', () => {
  afterEach(() => jest.restoreAllMocks());

  it('cada 404 deja un evento de log con el motivo, la clínica y un hash de la IP; nunca el código ni la IP', async () => {
    const warn = jest
      .spyOn(Logger.prototype, 'warn')
      .mockImplementation(() => undefined);
    const { issue, verify, repo } = setup();
    const rx = await issue();
    const noTenant = setup({ withTenant: false });
    noTenant.repo.rows = repo.rows;
    const fail = (p: Promise<unknown>) =>
      p.then(
        () => null,
        (e: unknown) => e,
      );
    await fail(verify.execute('ZZZZZZZZZZZZ', META));
    await fail(verify.execute('no-es-un-codigo', META));
    await fail(noTenant.verify.execute(rx.verificationCode, META));
    await verify.execute(rx.verificationCode, META);
    const events = warn.mock.calls.map(([e]) => e as Record<string, unknown>);
    expect(events.map((e) => [e.event, e.reason, e.tenantId])).toEqual([
      ['prescription_verification.not_found', 'UNKNOWN', 't1'],
      ['prescription_verification.not_found', 'MALFORMED', 't1'],
      ['prescription_verification.not_found', 'NO_TENANT', null],
    ]);
    for (const e of events) {
      expect(e.ipHash).toMatch(/^[0-9a-f]{16}$/);
      expect(e.requestId).toBe('req-1');
    }
    // La misma IP da el mismo hash (se puede seguir un barrido)...
    expect(new Set(events.map((e) => e.ipHash)).size).toBe(1);
    // ...sin el código probado ni la IP en claro.
    const text = JSON.stringify(events);
    for (const leak of [
      'ZZZZZZZZZZZZ',
      'no-es-un-codigo',
      rx.verificationCode,
      META.ip as string,
    ]) {
      expect(text).not.toContain(leak);
    }
  });

  it('sin IP conocida, ipHash null', async () => {
    const warn = jest
      .spyOn(Logger.prototype, 'warn')
      .mockImplementation(() => undefined);
    const { verify } = setup();
    await verify
      .execute('ZZZZZZZZZZZZ', { ...META, ip: null })
      .catch(() => undefined);
    expect(warn.mock.calls[0][0]).toMatchObject({ ipHash: null });
  });
});

describe('PrescriptionVerificationLinks (DX-467)', () => {
  const links = (base: string | null, tenantId: string | null = 't1') => {
    const calls: [string, string | undefined][] = [];
    const service = new PrescriptionVerificationLinks(
      {
        forTenant: (id: string, host?: string) => {
          calls.push([id, host]);
          return Promise.resolve(base);
        },
      },
      { getTenantId: () => tenantId ?? undefined },
    );
    return { service, calls };
  };

  it('/receta/<código> en el host seguro de la clínica del contexto', async () => {
    const { service, calls } = links('https://demo.dentalix.app');
    await expect(
      service.urlFor('K7M2P9QRT4XW', 'demo.dentalix.app'),
    ).resolves.toBe('https://demo.dentalix.app/receta/K7M2P9QRT4XW');
    expect(calls).toEqual([['t1', 'demo.dentalix.app']]);
  });

  it('sin host seguro o sin clínica: sin URL (la receta imprime solo el código)', async () => {
    await expect(
      links(null).service.urlFor('K7M2P9QRT4XW'),
    ).resolves.toBeNull();
    const none = links('https://x.dentalix.app', null);
    await expect(none.service.urlFor('K7M2P9QRT4XW')).resolves.toBeNull();
    expect(none.calls).toEqual([]);
  });
});

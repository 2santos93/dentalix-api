import {
  BadRequestException,
  ConflictException,
  NotFoundException,
} from '@nestjs/common';
import { TreatmentPlanStatus } from '@prisma/client';
import {
  AcceptTreatmentPlanUseCase,
  GetPlanQuoteUseCase,
  PLAN_ACCEPTED_CONFLICT_MESSAGE,
  QUOTE_CHANGED_MESSAGE,
} from './plan-quote.use-cases';
import {
  InMemoryPlanQuoteRepository,
  quoteSource,
} from './__fixtures__/in-memory-plan-quote.repository';
import {
  buildQuoteContent,
  computeAcceptanceHash,
  computeQuoteHash,
  parseQuoteContent,
} from '../../domain/plan-quote';

// PNG real de 1x1 (firma + IHDR).
const PNG =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';
// 16 oct 2026, 10:00 en Bogotá (UTC-5).
const NOW = new Date('2026-10-16T15:00:00.000Z');
const META = {
  acceptedById: 'user-1',
  ipAddress: '10.0.0.1',
  userAgent: 'jest',
};

function setup() {
  const repo = new InMemoryPlanQuoteRepository();
  repo.add(quoteSource());
  const clock = () => NOW;
  return {
    repo,
    get: new GetPlanQuoteUseCase(repo, clock),
    accept: new AcceptTreatmentPlanUseCase(repo, clock),
  };
}

describe('GetPlanQuoteUseCase (DX-012)', () => {
  it('entrega organización separada del contenido sellado (DX-256)', async () => {
    const repo = new InMemoryPlanQuoteRepository();
    const source = quoteSource();
    Object.assign(source, {
      visitOrganization: [
        {
          itemId: 'item-1',
          visit: 2,
          label: 'Corona',
          minDaysAfterPrevious: 90,
        },
        { itemId: 'item-2', visit: 1, label: null, minDaysAfterPrevious: 0 },
      ],
    });
    repo.add(source);
    const get = new GetPlanQuoteUseCase(repo, () => NOW);
    const doc = await get.execute('patient-1', 'plan-1');
    expect(doc).toHaveProperty('visitOrganization', [
      { itemId: 'item-1', visit: 2, label: 'Corona', minDaysAfterPrevious: 90 },
      { itemId: 'item-2', visit: 1, label: null, minDaysAfterPrevious: 0 },
    ]);
    expect(doc.contentHash).toBe(computeQuoteHash(doc));
  });

  it('compone el presupuesto con la fecha de hoy en la zona de la sede y su hash', async () => {
    const { get } = setup();
    // 23:30 del 15 en Bogotá = 04:30 UTC del 16: el presupuesto es del 15.
    const lateRepo = new InMemoryPlanQuoteRepository();
    lateRepo.add(quoteSource());
    const late = new GetPlanQuoteUseCase(
      lateRepo,
      () => new Date('2026-10-16T04:30:00.000Z'),
    );
    const doc = await get.execute('patient-1', 'plan-1');

    expect(doc.issuedOn).toBe('2026-10-16');
    expect(doc.validUntil).toBe('2026-11-15');
    expect(doc.clinicName).toBe('Clínica Sonrisa');
    expect(doc.clinicLogoUrl).toBeNull();
    expect(doc.patient).toEqual({ name: 'Ana Pérez', document: 'CC 123' });
    expect(doc.professionalName).toBe('Dra. Gómez');
    expect(doc.planStatus).toBe(TreatmentPlanStatus.DRAFT);
    expect(doc.totals).toEqual([
      {
        currency: 'COP',
        gross: 3680000,
        discount: 350000,
        net: 3330000,
        agreementSaving: 0,
      },
    ]);
    expect(doc.contentHash).toBe(
      computeQuoteHash(
        buildQuoteContent(
          {
            planId: 'plan-1',
            patientId: 'patient-1',
            currency: 'COP',
            clinicName: 'Clínica Sonrisa',
            location: {
              id: 'loc-1',
              name: 'Sede principal',
              address: 'Calle 1',
            },
            patient: { name: 'Ana Pérez', document: 'CC 123' },
            professionalName: 'Dra. Gómez',
            items: quoteSource().items,
          },
          '2026-10-16',
        ),
      ),
    );
    expect(doc.acceptance).toBeNull();
    expect(doc.version).toBe(2);
    expect(doc.agreement).toBeNull();

    expect((await late.execute('patient-1', 'plan-1')).issuedOn).toBe(
      '2026-10-15',
    );
  });

  it('un paciente sin documento sale como null, no como texto vacío', async () => {
    const { repo, get } = setup();
    repo.add(
      quoteSource({
        patient: {
          firstName: 'Luis',
          lastName: 'Ruiz',
          docType: 'CC',
          docNumber: null,
        },
      }),
    );
    expect(
      (await get.execute('patient-1', 'plan-1')).patient.document,
    ).toBeNull();
  });

  it('404 si el plan no existe, es de otra clínica o de otro paciente', async () => {
    const { get } = setup();
    await expect(get.execute('patient-1', 'plan-x')).rejects.toBeInstanceOf(
      NotFoundException,
    );
    await expect(get.execute('patient-2', 'plan-1')).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  it('un plan aceptado devuelve la foto firmada (no el plan vivo) y verifica su integridad', async () => {
    const { repo, get, accept } = setup();
    const shown = await get.execute('patient-1', 'plan-1');
    await accept.execute(
      'patient-1',
      'plan-1',
      {
        signerName: 'Ana Pérez',
        signature: `data:image/png;base64,${PNG}`,
        contentHash: shown.contentHash,
      },
      META,
    );
    // El plan vivo cambia después (p. ej. el catálogo renombra el procedimiento):
    const stored = repo.sources.get('plan-1')!;
    repo.add({
      ...stored,
      items: [{ ...stored.items[0], procedure: 'Otro nombre' }],
    });

    const later = new GetPlanQuoteUseCase(
      repo,
      () => new Date('2026-12-01T15:00:00.000Z'),
    );
    const doc = await later.execute('patient-1', 'plan-1');
    expect(doc.issuedOn).toBe('2026-10-16');
    expect(doc.items.map((i) => i.procedure)).toEqual(['Implante', 'Resina']);
    expect(doc.contentHash).toBe(shown.contentHash);
    expect(doc.planStatus).toBe(TreatmentPlanStatus.ACCEPTED);
    expect(doc.acceptance).toEqual({
      signerName: 'Ana Pérez',
      signature: PNG,
      acceptedAt: NOW,
      acceptedByName: 'Dra. Gómez',
      acceptanceHash: computeAcceptanceHash({
        contentHash: shown.contentHash,
        signerName: 'Ana Pérez',
        signature: PNG,
        acceptedAt: NOW,
      }),
      integrityOk: true,
    });
  });

  it('con convenio: muestra convenio, precio de lista y ahorro, y la firma v2 sigue íntegra', async () => {
    const { repo, get, accept } = setup();
    const base = quoteSource();
    repo.add(
      quoteSource({
        items: [
          {
            ...base.items[0],
            price: 850,
            discount: 0,
            basePrice: 1000,
            referencePrice: 850,
            agreementName: 'Sura EPS −15 %',
            agreementPayerName: 'Sura EPS',
          },
        ],
      }),
    );
    const shown = await get.execute('patient-1', 'plan-1');
    expect(shown.version).toBe(2);
    expect(shown.agreement).toEqual({
      name: 'Sura EPS −15 %',
      payerName: 'Sura EPS',
    });
    expect(shown.items[0].listPrice).toBe(1000);
    expect(shown.totals[0].agreementSaving).toBe(150);

    const signed = await accept.execute(
      'patient-1',
      'plan-1',
      {
        signerName: 'Ana Pérez',
        signature: PNG,
        contentHash: shown.contentHash,
      },
      META,
    );
    expect(signed.version).toBe(2);
    expect(signed.acceptance?.integrityOk).toBe(true);
    expect(signed.agreement?.name).toBe('Sura EPS −15 %');
    expect(
      (repo.sources.get('plan-1')!.acceptance!.content as { version: number })
        .version,
    ).toBe(2);
  });

  it('una aceptación v1 ya guardada sigue íntegra y se muestra sin convenio', async () => {
    const repo = new InMemoryPlanQuoteRepository();
    const v1 = {
      version: 1,
      planId: 'plan-1',
      patientId: 'patient-1',
      currency: 'COP',
      clinicName: 'Clínica Sonrisa',
      location: { id: 'loc-1', name: 'Sede principal', address: 'Calle 1' },
      patient: { name: 'Ana Pérez', document: 'CC 123' },
      professionalName: 'Dra. Gómez',
      issuedOn: '2026-10-01',
      validUntil: '2026-10-31',
      validityDays: 30,
      items: [
        {
          id: 'item-1',
          toothNumber: '36',
          surfaces: [],
          procedure: 'Implante',
          quantity: 1,
          unitPrice: 1000,
          discount: 0,
          subtotal: 1000,
        },
      ],
      totals: [{ currency: 'COP', gross: 1000, discount: 0, net: 1000 }],
    };
    const contentHash = computeQuoteHash(parseQuoteContent(v1));
    const acceptedAt = new Date('2026-10-02T15:00:00.000Z');
    repo.add(
      quoteSource({
        plan: {
          id: 'plan-1',
          patientId: 'patient-1',
          status: TreatmentPlanStatus.ACCEPTED,
          currency: 'COP',
        },
        acceptance: {
          content: v1,
          contentHash,
          signerName: 'Ana Pérez',
          signature: PNG,
          acceptedAt,
          acceptedByName: 'Dra. Gómez',
          acceptanceHash: computeAcceptanceHash({
            contentHash,
            signerName: 'Ana Pérez',
            signature: PNG,
            acceptedAt,
          }),
        },
      }),
    );
    const doc = await new GetPlanQuoteUseCase(repo, () => NOW).execute(
      'patient-1',
      'plan-1',
    );
    expect(doc.version).toBe(1);
    expect(doc.agreement).toBeNull();
    expect(doc.contentHash).toBe(contentHash);
    expect(doc.acceptance?.integrityOk).toBe(true);
  });

  it('marca integrityOk=false si la foto o la firma se alteraron por fuera', async () => {
    const { repo, get, accept } = setup();
    const shown = await get.execute('patient-1', 'plan-1');
    await accept.execute(
      'patient-1',
      'plan-1',
      {
        signerName: 'Ana Pérez',
        signature: PNG,
        contentHash: shown.contentHash,
      },
      META,
    );
    const stored = repo.sources.get('plan-1')!;
    const content = stored.acceptance!.content as { totals: { net: number }[] };
    content.totals[0].net = 1;
    expect(
      (await get.execute('patient-1', 'plan-1')).acceptance?.integrityOk,
    ).toBe(false);

    repo.add({
      ...stored,
      acceptance: {
        ...stored.acceptance!,
        content: JSON.parse(JSON.stringify(shown)) as unknown,
        signerName: 'Otra',
      },
    });
    expect(
      (await get.execute('patient-1', 'plan-1')).acceptance?.integrityOk,
    ).toBe(false);
  });
});

describe('AcceptTreatmentPlanUseCase (DX-012)', () => {
  async function shownHash(get: GetPlanQuoteUseCase): Promise<string> {
    return (await get.execute('patient-1', 'plan-1')).contentHash;
  }

  it('acepta con la firma: guarda quién, cuándo (servidor), la foto y su hash', async () => {
    const { repo, get, accept } = setup();
    const contentHash = await shownHash(get);
    const doc = await accept.execute(
      'patient-1',
      'plan-1',
      {
        signerName: '  Ana Pérez ',
        signature: `data:image/png;base64,${PNG}`,
        contentHash,
      },
      META,
    );

    expect(repo.inserted).toHaveLength(1);
    const row = repo.inserted[0];
    expect(row).toMatchObject({
      locationId: 'loc-1',
      signerName: 'Ana Pérez',
      signature: PNG,
      contentHash,
      acceptedAt: NOW,
      acceptedById: 'user-1',
      ipAddress: '10.0.0.1',
      userAgent: 'jest',
    });
    expect(computeQuoteHash(row.content as never)).toBe(contentHash);
    expect(row.acceptanceHash).toBe(
      computeAcceptanceHash({
        contentHash,
        signerName: 'Ana Pérez',
        signature: PNG,
        acceptedAt: NOW,
      }),
    );
    expect(doc.acceptance?.integrityOk).toBe(true);
    expect(doc.planStatus).toBe(TreatmentPlanStatus.ACCEPTED);
  });

  it('sin firma, o con una firma que no es PNG, no acepta (400) y no escribe nada', async () => {
    const { repo, get, accept } = setup();
    const contentHash = await shownHash(get);
    for (const signature of [
      '',
      '   ',
      'data:image/jpeg;base64,AAAA',
      'no-es-base64!',
    ]) {
      await expect(
        accept.execute(
          'patient-1',
          'plan-1',
          { signerName: 'Ana', signature, contentHash },
          META,
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
    }
    expect(repo.inserted).toHaveLength(0);
  });

  it('exige el nombre de quien firma (400)', async () => {
    const { get, accept } = setup();
    const contentHash = await shownHash(get);
    await expect(
      accept.execute(
        'patient-1',
        'plan-1',
        { signerName: '  ', signature: PNG, contentHash },
        META,
      ),
    ).rejects.toThrow('El nombre de quien firma es obligatorio');
  });

  it('409 si el presupuesto cambió desde que se mostró (hash distinto)', async () => {
    const { repo, accept } = setup();
    await expect(
      accept.execute(
        'patient-1',
        'plan-1',
        { signerName: 'Ana', signature: PNG, contentHash: 'f'.repeat(64) },
        META,
      ),
    ).rejects.toThrow(QUOTE_CHANGED_MESSAGE);
    expect(repo.inserted).toHaveLength(0);
  });

  it('409 al volver a firmar un plan ya aceptado', async () => {
    const { get, accept } = setup();
    const contentHash = await shownHash(get);
    const input = { signerName: 'Ana', signature: PNG, contentHash };
    await accept.execute('patient-1', 'plan-1', input, META);
    const again = accept.execute('patient-1', 'plan-1', input, META);
    await expect(again).rejects.toBeInstanceOf(ConflictException);
    await expect(
      accept.execute('patient-1', 'plan-1', input, META),
    ).rejects.toThrow(PLAN_ACCEPTED_CONFLICT_MESSAGE);
  });

  it('409 si la base rechaza la segunda aceptación simultánea (índice único)', async () => {
    const { repo, get, accept } = setup();
    const contentHash = await shownHash(get);
    jest
      .spyOn(repo, 'accept')
      .mockResolvedValueOnce({ kind: 'ALREADY_ACCEPTED' });
    await expect(
      accept.execute(
        'patient-1',
        'plan-1',
        { signerName: 'Ana', signature: PNG, contentHash },
        META,
      ),
    ).rejects.toThrow(PLAN_ACCEPTED_CONFLICT_MESSAGE);
  });

  it('400 si el plan no tiene ítems', async () => {
    const { repo, get, accept } = setup();
    repo.add(quoteSource({ items: [] }));
    const contentHash = await shownHash(get);
    await expect(
      accept.execute(
        'patient-1',
        'plan-1',
        { signerName: 'Ana', signature: PNG, contentHash },
        META,
      ),
    ).rejects.toThrow('El plan no tiene ítems');
  });

  it('acepta un plan presentado (DX-040: PRESENTED → ACCEPTED)', async () => {
    const { repo, get, accept } = setup();
    repo.add(
      quoteSource({
        plan: { ...quoteSource().plan, status: TreatmentPlanStatus.PRESENTED },
      }),
    );
    const contentHash = await shownHash(get);
    const doc = await accept.execute(
      'patient-1',
      'plan-1',
      { signerName: 'Ana', signature: PNG, contentHash },
      META,
    );
    expect(doc.planStatus).toBe(TreatmentPlanStatus.ACCEPTED);
  });

  it('409 si el plan está cancelado, completado o rechazado (máquina de estados)', async () => {
    for (const status of [
      TreatmentPlanStatus.CANCELLED,
      TreatmentPlanStatus.COMPLETED,
      TreatmentPlanStatus.REJECTED,
    ]) {
      const { repo, get, accept } = setup();
      repo.add(quoteSource({ plan: { ...quoteSource().plan, status } }));
      const contentHash = await shownHash(get);
      await expect(
        accept.execute(
          'patient-1',
          'plan-1',
          { signerName: 'Ana', signature: PNG, contentHash },
          META,
        ),
      ).rejects.toBeInstanceOf(ConflictException);
    }
  });

  it('404 si el plan no es de este paciente o de esta clínica', async () => {
    const { accept } = setup();
    await expect(
      accept.execute(
        'patient-2',
        'plan-1',
        { signerName: 'Ana', signature: PNG, contentHash: 'a'.repeat(64) },
        META,
      ),
    ).rejects.toBeInstanceOf(NotFoundException);
  });
});

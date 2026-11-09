import {
  BadRequestException,
  ConflictException,
  NotFoundException,
} from '@nestjs/common';
import { ClinicRole, TreatmentPlanStatus } from '@prisma/client';
import {
  AcceptTreatmentPlanUseCase,
  composeQuoteContent,
  GetPlanQuoteUseCase,
  IssuePlanQuoteUseCase,
  PLAN_ACCEPTED_CONFLICT_MESSAGE,
  QUOTE_CHANGED_MESSAGE,
} from './plan-quote.use-cases';
import {
  InMemoryPlanQuoteRepository,
  quoteSource,
} from './__fixtures__/in-memory-plan-quote.repository';
import { NO_EXPIRED_ACCEPTANCE } from '../../domain/expired-quote-acceptance';
import {
  buildQuoteContent,
  computeAcceptanceHash,
  computeQuoteHash,
  parseQuoteContent,
} from '../../domain/plan-quote';
import { FixedDocumentTypeNamesReader } from '../../../document-type-names/__fixtures__/fixed-document-type-names.reader';

// PNG real de 1x1 (firma + IHDR).
const PNG =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';
// 16 oct 2026, 10:00 en la zona de la sede (UTC-4).
const NOW = new Date('2026-10-16T14:00:00.000Z');
const LOGO_A = 'https://api.example/api/v1/files/logos/a-0123456789abcdef.png';
const LOGO_B = 'https://api.example/api/v1/files/logos/a-fedcba9876543210.png';
const META = {
  acceptedById: 'user-1',
  role: ClinicRole.DENTIST,
  ipAddress: '10.0.0.1',
  userAgent: 'jest',
};

// DX-327: los nombres locales de la clínica; cada test empieza sin ninguno.
let names: FixedDocumentTypeNamesReader;
beforeEach(() => {
  names = new FixedDocumentTypeNamesReader();
});

function setup() {
  const repo = new InMemoryPlanQuoteRepository();
  repo.add(quoteSource());
  const clock = () => NOW;
  return {
    repo,
    get: new GetPlanQuoteUseCase(repo, clock, names),
    accept: new AcceptTreatmentPlanUseCase(repo, clock, names),
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
    const get = new GetPlanQuoteUseCase(repo, () => NOW, names);
    const doc = await get.execute('patient-1', 'plan-1');
    expect(doc).toHaveProperty('visitOrganization', [
      { itemId: 'item-1', visit: 2, label: 'Corona', minDaysAfterPrevious: 90 },
      { itemId: 'item-2', visit: 1, label: null, minDaysAfterPrevious: 0 },
    ]);
    expect(doc.contentHash).toBe(computeQuoteHash(doc));
  });

  it('compone el presupuesto con la fecha de hoy en la zona de la sede y su hash', async () => {
    const { get } = setup();
    // 23:30 del 15 en la zona de la sede = 03:30 UTC del 16: el presupuesto es del 15.
    const lateRepo = new InMemoryPlanQuoteRepository();
    lateRepo.add(quoteSource());
    const late = new GetPlanQuoteUseCase(
      lateRepo,
      () => new Date('2026-10-16T03:30:00.000Z'),
      names,
    );
    const doc = await get.execute('patient-1', 'plan-1');

    expect(doc.issuedOn).toBe('2026-10-16');
    expect(doc.validUntil).toBe('2026-11-15');
    expect(doc.clinicName).toBe('Clínica Sonrisa');
    expect(doc.clinicLogoUrl).toBeNull();
    expect(doc.patient).toEqual({
      name: 'Ana Pérez',
      document: 'Documento nacional 123',
    });
    expect(doc.professionalName).toBe('Dra. Gómez');
    expect(doc.planStatus).toBe(TreatmentPlanStatus.DRAFT);
    expect(doc.totals).toEqual([
      {
        currency: 'USD',
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
            currency: 'USD',
            clinicName: 'Clínica Sonrisa',
            location: {
              id: 'loc-1',
              name: 'Sede principal',
              address: 'Calle 1',
            },
            patient: { name: 'Ana Pérez', document: 'Documento nacional 123' },
            professionalName: 'Dra. Gómez',
            items: quoteSource().items,
          },
          { issuedOn: '2026-10-16', validUntil: '2026-11-15' },
        ),
      ),
    );
    expect(doc.acceptance).toBeNull();
    expect(doc.version).toBe(4);
    expect(doc.agreement).toBeNull();

    expect((await late.execute('patient-1', 'plan-1')).issuedOn).toBe(
      '2026-10-15',
    );
  });

  it('the live quote prints the current display name', async () => {
    const { repo, get } = setup();
    const document = async () =>
      (await get.execute('patient-1', 'plan-1')).patient.document;
    expect(await document()).toBe('Documento nacional 123');

    names.names.NATIONAL_ID = 'Documento A';
    expect(await document()).toBe('Documento A 123');

    const stored = repo.sources.get('plan-1')!;
    repo.add({
      ...stored,
      patient: { ...stored.patient, docTypeLabel: 'ID local' },
    });
    expect(await document()).toBe('ID local 123');
  });

  it('un paciente sin documento sale como null, no como texto vacío', async () => {
    const { repo, get } = setup();
    repo.add(
      quoteSource({
        patient: {
          firstName: 'Luis',
          lastName: 'Ruiz',
          docType: 'NATIONAL_ID',
          docTypeLabel: null,
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

  it('DX-354: lleva el regional de la sede del documento y no cambia el hash', async () => {
    const { repo, get } = setup();
    const withRegional = await get.execute('patient-1', 'plan-1');
    expect(withRegional.regional).toEqual({
      timeZone: 'America/Caracas',
      locale: 'es-VE',
      hourCycle: 'h12',
    });
    // Sin reloj: null y el mismo hash (la región no es contenido firmado).
    repo.add({ ...repo.sources.get('plan-1')!, regional: null });
    const without = await get.execute('patient-1', 'plan-1');
    expect(without.regional).toBeNull();
    expect(without.contentHash).toBe(withRegional.contentHash);
  });

  it('DX-019-bis (B): sin firmar, el logo de hoy; firmado, el congelado al firmar (aunque luego cambie o se quite)', async () => {
    const { repo, get, accept } = setup();
    const withLogo = (url: string | null) => {
      const current = repo.sources.get('plan-1')!;
      repo.add({
        ...current,
        clinic: { ...current.clinic, logoUrl: url, logoKey: url && 'logos/x' },
      });
    };
    withLogo(LOGO_A);
    expect((await get.execute('patient-1', 'plan-1')).clinicLogoUrl).toBe(
      LOGO_A,
    );
    withLogo(LOGO_B);
    const shown = await get.execute('patient-1', 'plan-1');
    expect(shown.clinicLogoUrl).toBe(LOGO_B);
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
    withLogo(LOGO_A);
    const signed = await get.execute('patient-1', 'plan-1');
    expect(signed.clinicLogoUrl).toBe(LOGO_B);
    // Fuera del hash (D6): el logo no toca la integridad.
    expect(signed.acceptance?.integrityOk).toBe(true);
    withLogo(null);
    expect((await get.execute('patient-1', 'plan-1')).clinicLogoUrl).toBe(
      LOGO_B,
    );
  });

  it('DX-019-bis (B): firmado sin logo, se imprime sin logo aunque hoy la clínica tenga uno', async () => {
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
    const current = repo.sources.get('plan-1')!;
    repo.add({
      ...current,
      clinic: { ...current.clinic, logoUrl: LOGO_A, logoKey: 'logos/a' },
    });
    expect((await get.execute('patient-1', 'plan-1')).clinicLogoUrl).toBeNull();
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
      () => new Date('2026-12-01T14:00:00.000Z'),
      names,
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
      // Firmada en la clínica: sin evidencias del enlace (DX-415).
      remote: null,
      ipAddress: '10.0.0.1',
      userAgent: 'jest',
      // DX-379 (C): sin validez guardada ni vencimiento.
      quoteValidUntil: null,
      expiredMode: null,
      expiredReason: null,
      expiredNote: null,
      repricingId: null,
      // DX-417: aceptado entero.
      pendingPlanId: null,
      pendingItemIds: null,
      pendingTotal: null,
    });
  });

  it('con convenio: muestra convenio, precio de lista y ahorro, y la firma v4 sigue íntegra', async () => {
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
            agreementName: 'Surco Salud −15 %',
            agreementPayerName: 'Surco Salud',
            listPriceCurrency: 'USD',
          },
        ],
      }),
    );
    const shown = await get.execute('patient-1', 'plan-1');
    expect(shown.version).toBe(4);
    expect(shown.agreement).toEqual({
      name: 'Surco Salud −15 %',
      payerName: 'Surco Salud',
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
    expect(signed.version).toBe(4);
    expect(signed.acceptance?.integrityOk).toBe(true);
    expect(signed.agreement?.name).toBe('Surco Salud −15 %');
    expect(
      (repo.sources.get('plan-1')!.acceptance!.content as { version: number })
        .version,
    ).toBe(4);
  });

  it('una aceptación v1 ya guardada sigue íntegra y se muestra sin convenio', async () => {
    const repo = new InMemoryPlanQuoteRepository();
    const v1 = {
      version: 1,
      planId: 'plan-1',
      patientId: 'patient-1',
      currency: 'USD',
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
      totals: [{ currency: 'USD', gross: 1000, discount: 0, net: 1000 }],
    };
    const contentHash = computeQuoteHash(parseQuoteContent(v1));
    const acceptedAt = new Date('2026-10-02T14:00:00.000Z');
    repo.add(
      quoteSource({
        plan: {
          id: 'plan-1',
          patientId: 'patient-1',
          status: TreatmentPlanStatus.ACCEPTED,
          currency: 'USD',
          quoteIssuedOn: null,
          quoteValidUntil: null,
          presentedLocationId: null,
          quoteRegional: {
            locationId: 'loc-1',
            timeZone: 'America/Caracas',
            locale: 'es-VE',
            hourCycle: 'h12',
          },
        },
        acceptance: {
          content: v1,
          contentHash,
          signerName: 'Ana Pérez',
          signature: PNG,
          acceptedAt,
          acceptedByName: 'Dra. Gómez',
          ipAddress: null,
          userAgent: null,
          remote: null,
          clinicLogoUrl: null,
          expiry: NO_EXPIRED_ACCEPTANCE,
          acceptanceHash: computeAcceptanceHash({
            contentHash,
            signerName: 'Ana Pérez',
            signature: PNG,
            acceptedAt,
          }),
        },
      }),
    );
    const doc = await new GetPlanQuoteUseCase(repo, () => NOW, names).execute(
      'patient-1',
      'plan-1',
    );
    expect(doc.version).toBe(1);
    expect(doc.agreement).toBeNull();
    expect(doc.contentHash).toBe(contentHash);
    expect(doc.acceptance?.integrityOk).toBe(true);
  });

  it('DX-524: el presupuesto usa el nombre de la sede del plan al verlo y al aceptarlo, y los dos hashes coinciden', async () => {
    names.names.NATIONAL_ID = 'Documento clínica';
    names.byLocation.set('loc-1', { NATIONAL_ID: 'Documento sede' });
    names.activeLocationId = 'otra-sede';
    const { get, accept } = setup();
    const shown = await get.execute('patient-1', 'plan-1');
    expect(shown.patient.document).toBe('Documento sede 123');
    const accepted = await accept.execute(
      'patient-1',
      'plan-1',
      { signerName: 'Ana', signature: PNG, contentHash: shown.contentHash },
      META,
    );
    expect(accepted.patient.document).toBe('Documento sede 123');
  });

  it('an accepted quote prints its stored document without reading the clinic names', async () => {
    const { get, accept } = setup();
    await accept.execute(
      'patient-1',
      'plan-1',
      {
        signerName: 'Ana',
        signature: PNG,
        contentHash: (await get.execute('patient-1', 'plan-1')).contentHash,
      },
      META,
    );
    names.names.NATIONAL_ID = 'Documento A';
    const reads = names.reads;
    const doc = await get.execute('patient-1', 'plan-1');
    expect(doc.patient.document).toBe('Documento nacional 123');
    expect(doc.acceptance?.integrityOk).toBe(true);
    expect(names.reads).toBe(reads);
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

describe('DX-502: plan en EUR con el catálogo en VES', () => {
  /** Un ítem a precio de la lista de la sede (EUR) con el catálogo en VES. */
  function eurPlan(status: TreatmentPlanStatus = TreatmentPlanStatus.DRAFT) {
    const base = quoteSource();
    return quoteSource({
      plan: { ...base.plan, currency: 'EUR', status },
      items: [
        {
          ...base.items[0],
          price: 100.55,
          discount: 0,
          basePrice: 80000,
          referencePrice: 100.55,
          agreementName: 'Lista Euro',
          agreementPayerName: 'Aseguradora',
          listPriceCurrency: 'VES',
        },
      ],
    });
  }

  it('el presupuesto lleva el precio de lista en VES y no calcula ahorro entre monedas', async () => {
    const { repo, get } = setup();
    repo.add(eurPlan());
    const shown = await get.execute('patient-1', 'plan-1');
    expect(shown.currency).toBe('EUR');
    expect(shown.items[0]).toMatchObject({
      unitPrice: 100.55,
      listPrice: 80000,
      listPriceCurrency: 'VES',
    });
    expect(shown.totals[0]).toMatchObject({
      currency: 'EUR',
      net: 100.55,
      agreementSaving: 0,
    });
  });

  it('el firmado conserva la moneda del catálogo aunque luego cambie la del ítem', async () => {
    const { repo, get, accept } = setup();
    repo.add(eurPlan());
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
    // Las sedes pasan a USD: el ítem vivo diría otra cosa; la foto, no.
    const signed = repo.sources.get('plan-1')!;
    repo.add({
      ...signed,
      items: signed.items.map((i) => ({ ...i, listPriceCurrency: 'USD' })),
    });
    const printed = await get.execute('patient-1', 'plan-1');
    expect(printed.items[0].listPriceCurrency).toBe('VES');
    expect(printed.acceptance?.integrityOk).toBe(true);
  });

  it('una aceptación v2 guardada se completa con la moneda del ítem y sigue íntegra', async () => {
    const repo = new InMemoryPlanQuoteRepository();
    const source = eurPlan(TreatmentPlanStatus.ACCEPTED);
    const v2 = JSON.parse(
      JSON.stringify(
        buildQuoteContent(
          {
            planId: 'plan-1',
            patientId: 'patient-1',
            currency: 'EUR',
            clinicName: 'Clínica Sonrisa',
            location: { id: 'loc-1', name: 'Sede principal', address: null },
            patient: { name: 'Ana Pérez', document: null },
            professionalName: null,
            items: source.items,
          },
          { issuedOn: '2026-10-01', validUntil: '2026-10-31' },
          'legacy',
        ),
      ),
    ) as unknown;
    const contentHash = computeQuoteHash(parseQuoteContent(v2));
    const acceptedAt = new Date('2026-10-02T15:00:00.000Z');
    repo.add({
      ...source,
      acceptance: {
        content: v2,
        contentHash,
        signerName: 'Ana Pérez',
        signature: PNG,
        acceptedAt,
        acceptedByName: 'Dra. Gómez',
        ipAddress: null,
        userAgent: null,
        remote: null,
        clinicLogoUrl: null,
        expiry: NO_EXPIRED_ACCEPTANCE,
        acceptanceHash: computeAcceptanceHash({
          contentHash,
          signerName: 'Ana Pérez',
          signature: PNG,
          acceptedAt,
        }),
      },
    });
    const doc = await new GetPlanQuoteUseCase(repo, () => NOW, names).execute(
      'patient-1',
      'plan-1',
    );
    expect(doc.version).toBe(2);
    expect(doc.items[0].listPriceCurrency).toBe('VES');
    expect(doc.contentHash).toBe(contentHash);
    expect(doc.acceptance?.integrityOk).toBe(true);
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

  it('changing a local name between showing and accepting is 409; shown again, it signs the new text', async () => {
    const { repo, get, accept } = setup();
    const sign = (contentHash: string) =>
      accept.execute(
        'patient-1',
        'plan-1',
        { signerName: 'Ana', signature: PNG, contentHash },
        META,
      );
    const before = await shownHash(get);
    names.names.NATIONAL_ID = 'Documento A';
    await expect(sign(before)).rejects.toThrow(QUOTE_CHANGED_MESSAGE);
    expect(repo.inserted).toHaveLength(0);

    const doc = await sign(await shownHash(get));
    expect(doc.patient.document).toBe('Documento A 123');
    expect(doc.acceptance?.integrityOk).toBe(true);
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

describe('DX-502: PLAN_QUOTE_COMPOSE_V4 (con qué versión se componen los nuevos)', () => {
  const FISCAL = {
    legalName: 'Sonrisas S.A.',
    taxIdLabel: 'ID fiscal',
    taxId: 'J-1',
    address: null,
    email: null,
    phone: null,
  };
  /** Plan en USD con un ítem de convenio cuyo catálogo está en VES. */
  function source(fiscal = false) {
    const base = quoteSource();
    return quoteSource({
      clinic: fiscal ? { ...base.clinic, fiscal: FISCAL } : base.clinic,
      items: [
        {
          ...base.items[0],
          price: 850,
          discount: 0,
          basePrice: 1000,
          referencePrice: 850,
          agreementName: 'Surco Salud −15 %',
          agreementPayerName: 'Surco Salud',
          listPriceCurrency: 'VES',
        },
      ],
    });
  }
  function useCases(composition?: 'current' | 'legacy') {
    const repo = new InMemoryPlanQuoteRepository();
    const clock = () => NOW;
    return {
      repo,
      get: new GetPlanQuoteUseCase(repo, clock, names, composition),
      accept: new AcceptTreatmentPlanUseCase(repo, clock, names, composition),
    };
  }

  it('en false compone como antes de DX-502: v2 (v3 con datos fiscales) con el hash de entonces', async () => {
    for (const [fiscal, version] of [
      [false, 2],
      [true, 3],
    ] as const) {
      const { repo, get } = useCases('legacy');
      repo.add(source(fiscal));
      const doc = await get.execute('patient-1', 'plan-1');
      expect(doc.version).toBe(version);
      expect(doc.contentHash).toBe(
        computeQuoteHash(
          composeQuoteContent(
            source(fiscal),
            { issuedOn: '2026-10-16', validUntil: '2026-11-15' },
            {},
            'legacy',
          ),
        ),
      );
      // Ahorro como antes (lo sella la v2/v3) y la moneda del precio de lista
      // completada solo para mostrarla: no entra en el hash.
      expect(doc.totals[0].agreementSaving).toBe(150);
      expect(doc.items[0].listPriceCurrency).toBe('VES');
      expect(computeQuoteHash(doc)).toBe(doc.contentHash);
    }
  });

  it('en true (y por defecto) compone la v4', async () => {
    for (const composition of ['current', undefined] as const) {
      const { repo, get } = useCases(composition);
      repo.add(source());
      const doc = await get.execute('patient-1', 'plan-1');
      expect(doc.version).toBe(4);
      expect(doc.totals[0].agreementSaving).toBe(0);
    }
  });

  it('en false se firma la v2 que se mostró, y sigue íntegra', async () => {
    const { repo, get, accept } = useCases('legacy');
    repo.add(source());
    const shown = await get.execute('patient-1', 'plan-1');
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
  });

  it('en false se sigue leyendo y verificando una aceptación v4 ya firmada', async () => {
    const current = useCases('current');
    current.repo.add(source());
    const shown = await current.get.execute('patient-1', 'plan-1');
    await current.accept.execute(
      'patient-1',
      'plan-1',
      {
        signerName: 'Ana Pérez',
        signature: PNG,
        contentHash: shown.contentHash,
      },
      META,
    );
    const legacyGet = new GetPlanQuoteUseCase(
      current.repo,
      () => NOW,
      names,
      'legacy',
    );
    const printed = await legacyGet.execute('patient-1', 'plan-1');
    expect(printed.version).toBe(4);
    expect(printed.contentHash).toBe(shown.contentHash);
    expect(printed.items[0].listPriceCurrency).toBe('VES');
    expect(printed.acceptance?.integrityOk).toBe(true);
  });
});

describe('DX-379: validez guardada del presupuesto', () => {
  const STORED = { quoteIssuedOn: '2026-10-02', quoteValidUntil: '2026-10-17' };
  const presented = (overrides: Partial<typeof STORED> = {}) =>
    quoteSource({
      plan: {
        ...quoteSource().plan,
        status: TreatmentPlanStatus.PRESENTED,
        ...STORED,
        ...overrides,
      },
    });

  it('con fechas guardadas, el presupuesto vivo las usa aunque se abra otro día', async () => {
    const repo = new InMemoryPlanQuoteRepository();
    repo.add(presented());
    const day1 = new GetPlanQuoteUseCase(repo, () => NOW, names);
    const day9 = new GetPlanQuoteUseCase(
      repo,
      () => new Date('2026-10-24T14:00:00.000Z'),
      names,
    );
    const a = await day1.execute('patient-1', 'plan-1');
    const b = await day9.execute('patient-1', 'plan-1');
    expect(a.issuedOn).toBe('2026-10-02');
    expect(a.validUntil).toBe('2026-10-17');
    expect(a.validityDays).toBe(15);
    // El hash del presupuesto vivo ya no cambia de un día a otro.
    expect(b.contentHash).toBe(a.contentHash);
    expect(b.issuedOn).toBe('2026-10-02');
  });

  it('sin fechas guardadas (plan anterior), se compone como hoy con los días del ajuste de la clínica', async () => {
    const repo = new InMemoryPlanQuoteRepository();
    repo.add(
      quoteSource({
        clinic: { ...quoteSource().clinic, quoteValidityDays: 10 },
      }),
    );
    const doc = await new GetPlanQuoteUseCase(repo, () => NOW, names).execute(
      'patient-1',
      'plan-1',
    );
    expect(doc.issuedOn).toBe('2026-10-16');
    expect(doc.validUntil).toBe('2026-10-26');
    expect(doc.validityDays).toBe(10);
  });

  it('el GET es solo lectura: no guarda fechas', async () => {
    const { repo, get } = setup();
    await get.execute('patient-1', 'plan-1');
    expect(repo.sources.get('plan-1')?.plan.quoteIssuedOn).toBeNull();
  });

  it('se firma la validez guardada: mostrar un día y firmar otro no da 409', async () => {
    const repo = new InMemoryPlanQuoteRepository();
    repo.add(presented());
    const shown = await new GetPlanQuoteUseCase(repo, () => NOW, names).execute(
      'patient-1',
      'plan-1',
    );
    const accept = new AcceptTreatmentPlanUseCase(
      repo,
      () => new Date('2026-10-17T03:59:00.000Z'), // 16 oct 23:59 en la sede
      names,
    );
    const doc = await accept.execute(
      'patient-1',
      'plan-1',
      {
        signerName: 'Ana Pérez',
        signature: PNG,
        contentHash: shown.contentHash,
      },
      META,
    );
    expect(doc.acceptance).not.toBeNull();
    expect(repo.inserted[0].content).toMatchObject({
      issuedOn: '2026-10-02',
      validUntil: '2026-10-17',
      validityDays: 15,
    });
  });
});

describe('IssuePlanQuoteUseCase (DX-379, D-2: imprimir por primera vez)', () => {
  function issueAt(repo: InMemoryPlanQuoteRepository, at: Date) {
    return new IssuePlanQuoteUseCase(repo, () => at, names);
  }

  it('un borrador sin fechas las fija con hoy (zona de la sede) + los días del ajuste y devuelve lo mismo que el GET', async () => {
    const repo = new InMemoryPlanQuoteRepository();
    repo.add(
      quoteSource({
        clinic: { ...quoteSource().clinic, quoteValidityDays: 20 },
      }),
    );
    // 23:30 del 15 de octubre en la sede.
    const at = new Date('2026-10-16T03:30:00.000Z');
    const doc = await issueAt(repo, at).execute('patient-1', 'plan-1');
    expect(repo.sources.get('plan-1')?.plan).toMatchObject({
      quoteIssuedOn: '2026-10-15',
      quoteValidUntil: '2026-11-04',
    });
    expect(doc.issuedOn).toBe('2026-10-15');
    expect(doc.validUntil).toBe('2026-11-04');
    const viaGet = await new GetPlanQuoteUseCase(repo, () => at, names).execute(
      'patient-1',
      'plan-1',
    );
    expect(doc).toEqual(viaGet);
  });

  it('es idempotente: reimprimir otro día (o con otro ajuste) devuelve las mismas fechas', async () => {
    const repo = new InMemoryPlanQuoteRepository();
    repo.add(quoteSource());
    const first = await issueAt(repo, NOW).execute('patient-1', 'plan-1');
    const source = repo.sources.get('plan-1')!;
    repo.add({
      ...source,
      clinic: { ...source.clinic, quoteValidityDays: 90 },
    });
    const again = await issueAt(
      repo,
      new Date('2026-11-20T14:00:00.000Z'),
    ).execute('patient-1', 'plan-1');
    expect(again.issuedOn).toBe(first.issuedOn);
    expect(again.validUntil).toBe(first.validUntil);
    expect(again.contentHash).toBe(first.contentHash);
  });

  it('un plan presentado con fechas no se toca', async () => {
    const repo = new InMemoryPlanQuoteRepository();
    repo.add(
      quoteSource({
        plan: {
          ...quoteSource().plan,
          status: TreatmentPlanStatus.PRESENTED,
          quoteIssuedOn: '2026-10-01',
          quoteValidUntil: '2026-10-31',
        },
      }),
    );
    const doc = await issueAt(repo, NOW).execute('patient-1', 'plan-1');
    expect(doc.issuedOn).toBe('2026-10-01');
    expect(repo.sources.get('plan-1')?.plan.quoteIssuedOn).toBe('2026-10-01');
  });

  it.each([
    TreatmentPlanStatus.ACCEPTED,
    TreatmentPlanStatus.REJECTED,
    TreatmentPlanStatus.CANCELLED,
    TreatmentPlanStatus.COMPLETED,
  ])('un plan %s no guarda fechas (solo se imprime)', async (status) => {
    const repo = new InMemoryPlanQuoteRepository();
    repo.add(quoteSource({ plan: { ...quoteSource().plan, status } }));
    await issueAt(repo, NOW).execute('patient-1', 'plan-1');
    expect(repo.sources.get('plan-1')?.plan.quoteIssuedOn).toBeNull();
  });

  it('un plan firmado no guarda fechas: se imprime su foto', async () => {
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
    // Aunque el estado vuelva a leerse como borrador, la firma manda.
    const signed = repo.sources.get('plan-1')!;
    repo.add({
      ...signed,
      plan: { ...signed.plan, status: TreatmentPlanStatus.DRAFT },
    });
    const doc = await issueAt(repo, NOW).execute('patient-1', 'plan-1');
    expect(repo.sources.get('plan-1')?.plan.quoteIssuedOn).toBeNull();
    expect(doc.acceptance).not.toBeNull();
  });

  it('M-5: un borrador sin ítems se imprime (en cero) sin guardar fechas', async () => {
    const repo = new InMemoryPlanQuoteRepository();
    repo.add(quoteSource({ items: [] }));
    const doc = await issueAt(repo, NOW).execute('patient-1', 'plan-1');
    expect(doc.totals[0].net).toBe(0);
    expect(repo.sources.get('plan-1')?.plan.quoteIssuedOn).toBeNull();
  });

  it('404 si el plan no es de este paciente', async () => {
    const repo = new InMemoryPlanQuoteRepository();
    repo.add(quoteSource());
    await expect(
      issueAt(repo, NOW).execute('patient-2', 'plan-1'),
    ).rejects.toBeInstanceOf(NotFoundException);
  });
});

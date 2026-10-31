import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { InMemoryAnesthesiaRepository } from '../__fixtures__/in-memory-anesthesia';
import {
  AnesthesiaUseCases,
  PEDIATRIC_WEIGHT_REQUIRED_MESSAGE,
} from './anesthesia.use-cases';
import { AnestheticCatalogUseCases } from './anesthetic-catalog.use-cases';
import type { TenantContextService } from '../../../../shared/tenancy/tenant-context.service';
import type { AnesthesiaPatientContext } from '../../domain/ports/anesthesia-repository.port';

const PATIENT = '11111111-1111-4111-8111-111111111111';
const ENTRY = '22222222-2222-4222-8222-222222222222';
const SEDE = '33333333-3333-4333-8333-333333333333';
const OTRA_SEDE = '44444444-4444-4444-8444-444444444444';
const AUTHOR = '55555555-5555-4555-8555-555555555555';
const NOW = new Date('2026-10-30T15:00:00.000Z');

function tenantContext(allowed: 'ALL' | string[] = 'ALL') {
  return {
    getAllowedLocationIds: () => allowed,
    assertLocationAllowed: (id: string) => {
      if (allowed !== 'ALL' && !allowed.includes(id)) {
        throw new ForbiddenException('Sede no permitida');
      }
    },
  } as unknown as TenantContextService;
}

function patient(
  overrides: Partial<AnesthesiaPatientContext> = {},
): AnesthesiaPatientContext {
  return {
    birthDate: new Date('2018-03-01T00:00:00.000Z'),
    anamnesis: { allergens: [], anestheticAllergyFlag: false, weightKg: 20 },
    ...overrides,
  };
}

async function setup(
  ctx: AnesthesiaPatientContext = patient(),
  allowed: 'ALL' | string[] = 'ALL',
) {
  const repo = new InMemoryAnesthesiaRepository();
  repo.patients.set(PATIENT, ctx);
  repo.entries.set(ENTRY, {
    id: ENTRY,
    patientId: PATIENT,
    locationId: SEDE,
    timeZone: 'America/Mexico_City',
  });
  const catalog = new AnestheticCatalogUseCases(repo);
  const [lido, arti] = await catalog.loadSamples(AUTHOR);
  // El criterio de DX-307 usa articaína en carpules de 1,7 ml.
  const uc = new AnesthesiaUseCases(repo, tenantContext(allowed));
  uc.now = () => NOW;
  return { repo, uc, lido, arti };
}

const base = { technique: 'INFILTRATION' as const };

describe('AnesthesiaUseCases (DX-307)', () => {
  it('3 carpules de articaína a 20 kg sin motivo → 409 con 204 mg de 140 (146 %), y no guarda', async () => {
    const { uc, arti, repo } = await setup();
    const err = await uc
      .record(
        PATIENT,
        ENTRY,
        { ...base, anestheticId: arti.id, carpules: 3 },
        AUTHOR,
      )
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ConflictException);
    const body = (err as ConflictException).getResponse() as {
      message: string;
      summary: { totalMg: number; percent: number };
    };
    expect(body.summary).toEqual(
      expect.objectContaining({ totalMg: 204, percent: 146 }),
    );
    expect(body.message).toContain('204 mg de 140 mg (146 %)');
    expect(repo.records).toHaveLength(0);
  });

  it('con motivo se guarda, sella el motivo, los avisos y la copia del catálogo', async () => {
    const { uc, arti } = await setup();
    const saved = await uc.record(
      PATIENT,
      ENTRY,
      {
        ...base,
        anestheticId: arti.id,
        carpules: 3,
        overrideReason: '  Exodoncia compleja, valorado con la madre  ',
        lot: ' L-123 ',
        site: '85',
      },
      AUTHOR,
    );
    expect(saved).toEqual(
      expect.objectContaining({
        doseMg: 204,
        cumulativeMg: 204,
        cumulativePercent: 146,
        overrideReason: 'Exodoncia compleja, valorado con la madre',
        lot: 'L-123',
        site: '85',
        weightKg: 20,
        weightSource: 'ANAMNESIS',
        anestheticName: arti.name,
        mlPerCarpule: 1.7,
        locationId: SEDE,
        authorId: AUTHOR,
        administeredAt: NOW,
      }),
    );
    expect(saved.safetyAlerts.map((a) => a.code)).toEqual(['DOSE_OVER_MAX']);
  });

  it('bajo el máximo no sella el motivo aunque venga', async () => {
    const { uc, lido } = await setup();
    const saved = await uc.record(
      PATIENT,
      ENTRY,
      {
        ...base,
        anestheticId: lido.id,
        carpules: 1,
        overrideReason: 'Motivo innecesario',
      },
      AUTHOR,
    );
    expect(saved.overrideReason).toBeNull();
    expect(saved.cumulativePercent).toBe(26);
  });

  it('el acumulado suma lo ya registrado en la evolución (suma de fracciones)', async () => {
    const { uc, lido, arti } = await setup();
    await uc.record(
      PATIENT,
      ENTRY,
      { ...base, anestheticId: lido.id, carpules: 2 },
      AUTHOR,
    );
    const check = await uc.check(PATIENT, ENTRY, {
      anestheticId: arti.id,
      carpules: 1,
    });
    expect(check.summary.percent).toBe(100);
    expect(check.summary.level).toBe('EXCEEDED');
    await expect(
      uc.record(
        PATIENT,
        ENTRY,
        { ...base, anestheticId: arti.id, carpules: 1 },
        AUTHOR,
      ),
    ).rejects.toBeInstanceOf(ConflictException);
    const listed = await uc.listByEntry(PATIENT, ENTRY);
    expect(listed.records).toHaveLength(1);
    expect(listed.summary.percent).toBe(51);
  });

  it('sin peso en un adulto: se guarda y dice que falta el peso', async () => {
    const { uc, lido } = await setup(
      patient({
        birthDate: new Date('1980-01-01T00:00:00.000Z'),
        anamnesis: {
          allergens: [],
          anestheticAllergyFlag: false,
          weightKg: null,
        },
      }),
    );
    const saved = await uc.record(
      PATIENT,
      ENTRY,
      { ...base, anestheticId: lido.id, carpules: 2 },
      AUTHOR,
    );
    expect(saved.cumulativePercent).toBeNull();
    expect(saved.weightKg).toBeNull();
    expect(saved.summary.alerts[0].message).toBe(
      'Dosis máxima no calculada: falta el peso.',
    );
  });

  it('menor de 12 años sin peso: pide el peso (400); con el peso anotado se guarda', async () => {
    const { uc, lido } = await setup(patient({ anamnesis: null }));
    const check = await uc.check(PATIENT, ENTRY, {
      anestheticId: lido.id,
      carpules: 1,
    });
    expect(check.weightRequired).toBe(true);
    expect(check.ageYears).toBe(8);
    await expect(
      uc.record(
        PATIENT,
        ENTRY,
        { ...base, anestheticId: lido.id, carpules: 1 },
        AUTHOR,
      ),
    ).rejects.toThrow(PEDIATRIC_WEIGHT_REQUIRED_MESSAGE);
    const saved = await uc.record(
      PATIENT,
      ENTRY,
      { ...base, anestheticId: lido.id, carpules: 1, weightKg: 18.04 },
      AUTHOR,
    );
    expect([saved.weightKg, saved.weightSource]).toEqual([18, 'ENTERED']);
    // El siguiente registro de la misma evolución reutiliza ese peso.
    const next = await uc.check(PATIENT, ENTRY, {
      anestheticId: lido.id,
      carpules: 1,
    });
    expect([
      next.summary.weightKg,
      next.weightSource,
      next.weightRequired,
    ]).toEqual([18, 'ENTERED', false]);
  });

  it('el peso medido en el sillón en esta evolución manda sobre el de la anamnesis (que puede ser antiguo)', async () => {
    // Anamnesis: 20 kg (antigua). En el sillón se pesa: 15 kg.
    const { uc, lido } = await setup();
    const first = await uc.record(
      PATIENT,
      ENTRY,
      { ...base, anestheticId: lido.id, carpules: 1, weightKg: 15 },
      AUTHOR,
    );
    expect([first.weightKg, first.weightSource]).toEqual([15, 'ENTERED']);
    // 2 carpules más (108 mg en total): 103 % de 105 mg a 15 kg, no 77 % de
    // 140 mg a 20 kg.
    const next = await uc.check(PATIENT, ENTRY, {
      anestheticId: lido.id,
      carpules: 2,
    });
    expect([next.summary.weightKg, next.weightSource]).toEqual([15, 'ENTERED']);
    expect(next.summary.level).toBe('EXCEEDED');
    const listed = await uc.listByEntry(PATIENT, ENTRY);
    expect(listed.summary.weightKg).toBe(15);
    expect(listed.summary.percent).toBe(first.cumulativePercent);
  });

  it('DX-407: sin peso anotado usa el pesado hoy en la valoración de sedación de la evolución, no el de la anamnesis', async () => {
    // Anamnesis: 20 kg (antigua). La valoración de sedación de ESTA evolución
    // pesó hoy 15 kg: 3 carpules de lidocaína (108 mg) son el 103 % de 105 mg,
    // no el 77 % de 140 mg.
    const { repo, uc, lido } = await setup();
    repo.entries.set(ENTRY, {
      ...repo.entries.get(ENTRY)!,
      sedationWeightKg: 15,
    });
    const check = await uc.check(PATIENT, ENTRY, {
      anestheticId: lido.id,
      carpules: 3,
    });
    expect([check.summary.weightKg, check.weightSource]).toEqual([
      15,
      'ENTERED',
    ]);
    expect(check.summary.level).toBe('EXCEEDED');
    // Lo anotado ahora sigue mandando.
    const entered = await uc.check(PATIENT, ENTRY, {
      anestheticId: lido.id,
      carpules: 1,
      weightKg: 16,
    });
    expect(entered.summary.weightKg).toBe(16);
    const listed = await uc.listByEntry(PATIENT, ENTRY);
    expect(listed.summary.weightKg).toBe(15);
  });

  it('evolución sin sede (sin zona horaria): la edad se calcula igual y un menor sin peso no se guarda', async () => {
    const { uc, repo, lido } = await setup(patient({ anamnesis: null }));
    repo.entries.set(ENTRY, {
      id: ENTRY,
      patientId: PATIENT,
      locationId: null,
      timeZone: null,
    });
    const check = await uc.check(PATIENT, ENTRY, {
      anestheticId: lido.id,
      carpules: 1,
    });
    expect([check.ageYears, check.weightRequired]).toEqual([8, true]);
    await expect(
      uc.record(
        PATIENT,
        ENTRY,
        { ...base, anestheticId: lido.id, carpules: 1 },
        AUTHOR,
      ),
    ).rejects.toThrow(PEDIATRIC_WEIGHT_REQUIRED_MESSAGE);
  });

  it('alergia a anestésicos en la anamnesis: 409 hasta confirmar con motivo', async () => {
    const { uc, lido } = await setup(
      patient({
        anamnesis: {
          allergens: ['Mepivacaína'],
          anestheticAllergyFlag: false,
          weightKg: 20,
        },
      }),
    );
    await expect(
      uc.record(
        PATIENT,
        ENTRY,
        { ...base, anestheticId: lido.id, carpules: 1 },
        AUTHOR,
      ),
    ).rejects.toBeInstanceOf(ConflictException);
    const saved = await uc.record(
      PATIENT,
      ENTRY,
      {
        ...base,
        anestheticId: lido.id,
        carpules: 1,
        overrideReason: 'Prueba de alergia negativa reciente',
      },
      AUTHOR,
    );
    expect(saved.safetyAlerts.map((a) => a.code)).toEqual([
      'ALLERGY_ANESTHETIC',
    ]);
  });

  it('validaciones: carpules, motivo corto, hora futura, anestésico desactivado', async () => {
    const { uc, lido, repo } = await setup();
    await expect(
      uc.record(
        PATIENT,
        ENTRY,
        { ...base, anestheticId: lido.id, carpules: 0.3 },
        AUTHOR,
      ),
    ).rejects.toBeInstanceOf(BadRequestException);
    await expect(
      uc.record(
        PATIENT,
        ENTRY,
        {
          ...base,
          anestheticId: lido.id,
          carpules: 1,
          overrideReason: 'corto',
        },
        AUTHOR,
      ),
    ).rejects.toBeInstanceOf(BadRequestException);
    await expect(
      uc.record(
        PATIENT,
        ENTRY,
        {
          ...base,
          anestheticId: lido.id,
          carpules: 1,
          administeredAt: new Date(NOW.getTime() + 60 * 60 * 1000),
        },
        AUTHOR,
      ),
    ).rejects.toBeInstanceOf(BadRequestException);
    repo.products[0].active = false;
    await expect(
      uc.check(PATIENT, ENTRY, { anestheticId: lido.id, carpules: 1 }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('paciente, evolución o anestésico ajenos → 404; sede no permitida → 403', async () => {
    const { uc, lido } = await setup();
    await expect(
      uc.check(ENTRY, ENTRY, { anestheticId: lido.id, carpules: 1 }),
    ).rejects.toBeInstanceOf(NotFoundException);
    await expect(
      uc.check(PATIENT, PATIENT, { anestheticId: lido.id, carpules: 1 }),
    ).rejects.toBeInstanceOf(NotFoundException);
    await expect(
      uc.check(PATIENT, ENTRY, { anestheticId: AUTHOR, carpules: 1 }),
    ).rejects.toBeInstanceOf(NotFoundException);
    const restricted = await setup(patient(), [OTRA_SEDE]);
    await expect(
      restricted.uc.listByEntry(PATIENT, ENTRY),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('la lista del paciente oculta la anestesia de sedes no permitidas', async () => {
    const { uc, lido, repo } = await setup();
    await uc.record(
      PATIENT,
      ENTRY,
      { ...base, anestheticId: lido.id, carpules: 1 },
      AUTHOR,
    );
    const restricted = new AnesthesiaUseCases(repo, tenantContext([OTRA_SEDE]));
    expect(await restricted.listByPatient(PATIENT)).toEqual([]);
    expect(await uc.listByPatient(PATIENT)).toHaveLength(1);
  });
});

describe('acumulado del paciente en 24 h (DX-418)', () => {
  const ENTRY_2 = '66666666-6666-4666-8666-666666666666';
  const OTRO_AUTOR = '77777777-7777-4777-8777-777777777777';
  const HOUR = 3_600_000;

  /** Segunda evolución del mismo paciente, en otra sede de la clínica. */
  async function twoEntries() {
    const ctx = await setup();
    ctx.repo.entries.set(ENTRY_2, {
      id: ENTRY_2,
      patientId: PATIENT,
      locationId: OTRA_SEDE,
      timeZone: 'America/Mexico_City',
    });
    ctx.repo.authorNames.set(AUTHOR, 'Dra. Ana');
    ctx.repo.authorNames.set(OTRO_AUTOR, 'Dr. Luis');
    ctx.repo.locationNames.set(SEDE, 'Centro');
    ctx.repo.locationNames.set(OTRA_SEDE, 'Norte');
    return ctx;
  }

  it('criterio: 20 kg, 3 carpules de lidocaína en E1 (77 %) y 3 en E2 → 409 con 216 mg (154 %); con motivo se guarda', async () => {
    const { uc, lido } = await twoEntries();
    const first = await uc.record(
      PATIENT,
      ENTRY,
      { ...base, anestheticId: lido.id, carpules: 3 },
      AUTHOR,
    );
    expect(first.cumulativePercent).toBe(77);
    expect(first.safetyAlerts).toEqual([]);

    const check = await uc.check(PATIENT, ENTRY_2, {
      anestheticId: lido.id,
      carpules: 3,
    });
    expect(check.summary).toEqual(
      expect.objectContaining({
        totalMg: 216,
        percent: 154,
        level: 'EXCEEDED',
      }),
    );
    expect(check.window.pendingMg).toBe(108);
    expect(check.window.parts).toEqual([
      expect.objectContaining({
        clinicalEntryId: ENTRY,
        current: false,
        authorName: 'Dra. Ana',
        locationName: 'Centro',
        mg: 108,
        percent: 77,
      }),
    ]);

    const err = await uc
      .record(
        PATIENT,
        ENTRY_2,
        { ...base, anestheticId: lido.id, carpules: 3 },
        OTRO_AUTOR,
      )
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ConflictException);
    expect(
      ((err as ConflictException).getResponse() as { message: string }).message,
    ).toContain('216 mg de 140 mg (154 %)');

    const saved = await uc.record(
      PATIENT,
      ENTRY_2,
      {
        ...base,
        anestheticId: lido.id,
        carpules: 3,
        overrideReason: 'Segunda cirugía urgente, valorado con la madre',
      },
      OTRO_AUTOR,
    );
    expect(saved).toEqual(
      expect.objectContaining({
        cumulativeMg: 216,
        cumulativePercent: 154,
        safetyRulesVersion: 'ANESTHESIA_DOSE_V2',
        overrideReason: 'Segunda cirugía urgente, valorado con la madre',
      }),
    );
  });

  it('cruzar el 80 % entre dos evoluciones avisa (sin bloquear)', async () => {
    const { uc, lido } = await twoEntries();
    await uc.record(
      PATIENT,
      ENTRY,
      { ...base, anestheticId: lido.id, carpules: 2 },
      AUTHOR,
    );
    const saved = await uc.record(
      PATIENT,
      ENTRY_2,
      { ...base, anestheticId: lido.id, carpules: 1.5 },
      OTRO_AUTOR,
    );
    expect(saved.cumulativePercent).toBe(90);
    expect(saved.overrideReason).toBeNull();
    expect(saved.safetyAlerts.map((a) => a.code)).toEqual(['DOSE_NEAR_MAX']);
  });

  it('la evolución lista sus registros y el acumulado del paciente, desglosado por evolución y profesional', async () => {
    const { uc, lido } = await twoEntries();
    await uc.record(
      PATIENT,
      ENTRY,
      { ...base, anestheticId: lido.id, carpules: 1 },
      AUTHOR,
    );
    await uc.record(
      PATIENT,
      ENTRY_2,
      { ...base, anestheticId: lido.id, carpules: 1 },
      OTRO_AUTOR,
    );
    await uc.record(
      PATIENT,
      ENTRY_2,
      { ...base, anestheticId: lido.id, carpules: 0.5 },
      AUTHOR,
    );
    const listed = await uc.listByEntry(PATIENT, ENTRY_2);
    expect(listed.records).toHaveLength(2);
    expect(listed.summary.totalMg).toBe(90);
    expect(listed.window).toEqual(
      expect.objectContaining({ hours: 24, pendingMg: null }),
    );
    expect(
      listed.window.parts.map((p) => [p.authorName, p.current, p.mg]),
    ).toEqual([
      ['Dra. Ana', false, 36],
      ['Dr. Luis', true, 36],
      ['Dra. Ana', true, 18],
    ]);
  });

  it('ventana móvil: lo de hace 23 h cuenta; lo de hace 25 h, no', async () => {
    const { uc, lido, repo } = await twoEntries();
    await uc.record(
      PATIENT,
      ENTRY,
      {
        ...base,
        anestheticId: lido.id,
        carpules: 3,
        administeredAt: new Date(NOW.getTime() - 25 * HOUR),
      },
      AUTHOR,
    );
    const old = await uc.check(PATIENT, ENTRY_2, {
      anestheticId: lido.id,
      carpules: 1,
    });
    expect(old.summary.totalMg).toBe(36);
    repo.records[0] = {
      ...repo.records[0],
      administeredAt: new Date(NOW.getTime() - 23 * HOUR),
    };
    const recent = await uc.check(PATIENT, ENTRY_2, {
      anestheticId: lido.id,
      carpules: 1,
    });
    expect(recent.summary.totalMg).toBe(144);
    expect(recent.summary.percent).toBe(103);
  });

  it('la ventana se centra en la hora anotada: anotada tarde ve también lo puesto después', async () => {
    const { uc, lido } = await twoEntries();
    await uc.record(
      PATIENT,
      ENTRY,
      { ...base, anestheticId: lido.id, carpules: 3 },
      AUTHOR,
    );
    const lateEntry = {
      anestheticId: lido.id,
      carpules: 3,
      administeredAt: new Date(NOW.getTime() - 3 * HOUR),
    };
    const check = await uc.check(PATIENT, ENTRY_2, lateEntry);
    expect(check.summary.percent).toBe(154);
    expect(check.window.from).toEqual(new Date(NOW.getTime() - 27 * HOUR));
    await expect(
      uc.record(PATIENT, ENTRY_2, { ...base, ...lateEntry }, OTRO_AUTOR),
    ).rejects.toBeInstanceOf(ConflictException);
    await expect(
      uc.check(PATIENT, ENTRY_2, {
        ...lateEntry,
        administeredAt: new Date(NOW.getTime() + HOUR),
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('un miembro de otra sede también ve lo puesto en esta (la seguridad del paciente manda)', async () => {
    const { uc, lido, repo } = await twoEntries();
    await uc.record(
      PATIENT,
      ENTRY,
      { ...base, anestheticId: lido.id, carpules: 3 },
      AUTHOR,
    );
    const north = new AnesthesiaUseCases(repo, tenantContext([OTRA_SEDE]));
    north.now = () => NOW;
    const check = await north.check(PATIENT, ENTRY_2, {
      anestheticId: lido.id,
      carpules: 3,
    });
    expect(check.summary.percent).toBe(154);
    expect(check.window.parts[0].locationName).toBe('Centro');
  });

  it('sin peso anotado usa el pesado en el sillón hoy en otra evolución antes que la anamnesis', async () => {
    const { uc, lido } = await twoEntries();
    await uc.record(
      PATIENT,
      ENTRY,
      { ...base, anestheticId: lido.id, carpules: 1, weightKg: 15 },
      AUTHOR,
    );
    const check = await uc.check(PATIENT, ENTRY_2, {
      anestheticId: lido.id,
      carpules: 1,
    });
    expect(check.summary.weightKg).toBe(15);
    expect(check.weightSource).toBe('ENTERED');
  });
});

describe('AnestheticCatalogUseCases (DX-307)', () => {
  it('cargar sugeridos crea los 5 una sola vez', async () => {
    const { repo } = await setup();
    const catalog = new AnestheticCatalogUseCases(repo);
    expect(repo.products).toHaveLength(5);
    expect(await catalog.loadSamples(AUTHOR)).toEqual([]);
  });

  it('nombre repetido → 409; editar un valor no toca lo ya registrado', async () => {
    const { repo, uc, lido } = await setup();
    const catalog = new AnestheticCatalogUseCases(repo);
    await expect(
      catalog.create(
        {
          name: lido.name,
          activeIngredient: 'Lidocaína',
          concentrationPct: 2,
          vasoconstrictor: null,
          mlPerCarpule: 1.8,
          maxMgPerKg: 4.4,
          maxAbsoluteMg: 300,
        },
        AUTHOR,
      ),
    ).rejects.toBeInstanceOf(ConflictException);
    const saved = await uc.record(
      PATIENT,
      ENTRY,
      { technique: 'NERVE_BLOCK', anestheticId: lido.id, carpules: 1 },
      AUTHOR,
    );
    await catalog.update(
      lido.id,
      { maxMgPerKg: 4.4, maxAbsoluteMg: 300 },
      AUTHOR,
    );
    expect(repo.records[0].maxMgPerKg).toBe(7);
    expect(saved.maxAbsoluteMg).toBe(500);
    await expect(
      catalog.update(PATIENT, { active: false }, AUTHOR),
    ).rejects.toBeInstanceOf(NotFoundException);
  });
});

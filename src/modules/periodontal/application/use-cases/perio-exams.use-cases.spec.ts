import {
  BadRequestException,
  ConflictException,
  NotFoundException,
} from '@nestjs/common';
import { patientsInClinic } from '../../../patients/application/__fixtures__/patients-in-clinic.fake';
import { InMemoryPerioExamRepository } from '../__fixtures__/in-memory-perio-exams';
import type { PerioSiteMeasure } from '../../domain/entities/perio-exam.entity';
import { PERIO_LIST_MAX } from '../../domain/perio-measures';
import type { RecordAuditEventUseCase } from '../../../audit/application/record-audit-event.use-case';
import type { AuditRequestContext } from '../../../audit/domain/audit-request-context';
import { sanitizeAuditMetadata } from '../../../audit/domain/audit-metadata';
import {
  ComparePerioExamsUseCase,
  GetPerioSettingsUseCase,
  PERIO_COMPARE_MESSAGES,
  PERIO_EXAM_FINAL_MESSAGE,
  UpdatePerioNotesUseCase,
  UpdatePerioSettingsUseCase,
  CreatePerioExamUseCase,
  DeletePerioExamUseCase,
  FinalizePerioExamUseCase,
  GetPerioExamUseCase,
  ListPerioExamsUseCase,
  SavePerioMeasuresUseCase,
} from './perio-exams.use-cases';

// 03:00 UTC del 16 de octubre = 22:00 del 15 en la zona de la sede: la fecha por defecto
// del examen es la del calendario de la clínica, no la UTC.
const NOW = new Date('2026-10-16T03:00:00.000Z');

function site(
  toothFdi: number,
  s: PerioSiteMeasure['site'],
  extra: Partial<PerioSiteMeasure> = {},
): PerioSiteMeasure {
  return {
    toothFdi,
    site: s,
    probingMm: null,
    recessionMm: null,
    furcation: null,
    bleeding: false,
    suppuration: false,
    plaque: false,
    calculus: false,
    ...extra,
  };
}

function setup() {
  const repo = new InMemoryPerioExamRepository();
  const patients = patientsInClinic('p1');
  const now = () => NOW;
  return {
    repo,
    list: new ListPerioExamsUseCase(repo, patients),
    create: new CreatePerioExamUseCase(repo, patients, now),
    get: new GetPerioExamUseCase(repo),
    save: new SavePerioMeasuresUseCase(repo),
    finalize: new FinalizePerioExamUseCase(repo, now),
    remove: new DeletePerioExamUseCase(repo),
    notes: new UpdatePerioNotesUseCase(repo),
    compare: new ComparePerioExamsUseCase(repo, patients),
  };
}

describe('CreatePerioExamUseCase', () => {
  it('crea un DRAFT con la fecha de hoy en la zona de la clínica y el autor del token', async () => {
    const { create } = setup();
    const exam = await create.execute('p1', {}, 'dentist-1');
    expect(exam).toMatchObject({
      patientId: 'p1',
      providerId: 'dentist-1',
      examDate: '2026-10-15',
      status: 'DRAFT',
      sites: [],
      teeth: [],
      indices: { sitesExamined: 0, bopPercent: 0 },
    });
  });

  it('«hoy» es el de la zona horaria de la sede activa (Europe/Madrid)', async () => {
    const { create, repo } = setup();
    // 03:00 UTC del 16 = 05:00 del 16 en Madrid (en Caracas aún sería el 15).
    repo.timeZone = 'Europe/Madrid';
    const exam = await create.execute('p1', {}, 'd');
    expect(exam.examDate).toBe('2026-10-16');
    // Y la fecha futura también se mide en Madrid.
    await expect(
      create.execute('p1', { examDate: '2026-10-17' }, 'd'),
    ).rejects.toThrow('La fecha del examen no puede ser futura');
  });

  it.each(['2026-02-31', '2026-02-29', '2025-04-31'])(
    '400 con la fecha imposible %s',
    async (examDate) => {
      const { create, repo } = setup();
      await expect(create.execute('p1', { examDate }, 'd')).rejects.toThrow(
        'La fecha del examen no existe en el calendario',
      );
      expect(repo.exams).toHaveLength(0);
    },
  );

  it('acepta el 29 de febrero de un año bisiesto', async () => {
    const { create } = setup();
    const exam = await create.execute('p1', { examDate: '2024-02-29' }, 'd');
    expect(exam.examDate).toBe('2024-02-29');
  });

  it('404 si el paciente no es de esta clínica', async () => {
    const { create } = setup();
    await expect(create.execute('otro', {}, 'd')).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  it('400 con fecha futura', async () => {
    const { create } = setup();
    await expect(
      create.execute('p1', { examDate: '2026-10-16' }, 'd'),
    ).rejects.toThrow('La fecha del examen no puede ser futura');
  });

  it('copia los dientes omitidos del último examen si se pide', async () => {
    const { create, save } = setup();
    const first = await create.execute('p1', { examDate: '2026-04-01' }, 'd');
    await save.execute('p1', first.id, {
      sites: [],
      teeth: [
        { toothFdi: 18, mobility: null, skipped: true },
        { toothFdi: 16, mobility: 2, skipped: false },
      ],
    });
    const second = await create.execute(
      'p1',
      { copySkippedFromLast: true },
      'd',
    );
    expect(second.teeth).toEqual([
      { toothFdi: 18, mobility: null, skipped: true },
    ]);
    const third = await create.execute('p1', {}, 'd');
    expect(third.teeth).toEqual([]);
  });
});

describe('SavePerioMeasuresUseCase / GetPerioExamUseCase', () => {
  it('guarda medidas y el detalle devuelve NIC = sondaje + recesión e índices', async () => {
    const { create, save, get } = setup();
    const exam = await create.execute('p1', {}, 'd');
    const saved = await save.execute('p1', exam.id, {
      sites: [
        site(16, 'MB', { probingMm: 5, recessionMm: 2, bleeding: true }),
        site(16, 'B', { probingMm: 3 }),
      ],
      teeth: [],
      notes: 'Control',
    });
    expect(saved.notes).toBe('Control');
    const detail = await get.execute('p1', exam.id);
    expect(detail.sites).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ toothFdi: 16, site: 'MB', calMm: 7 }),
        expect.objectContaining({ toothFdi: 16, site: 'B', calMm: 3 }),
      ]),
    );
    expect(detail.indices).toEqual({
      sitesExamined: 2,
      bopPercent: 50,
      plaquePercent: 0,
      sites4mmOrMore: 1,
      sites6mmOrMore: 0,
      sitesAlertOrMore: 1,
      sitesSevereOrMore: 0,
    });
  });

  it('un sitio vacío borra el valor anterior', async () => {
    const { create, save } = setup();
    const exam = await create.execute('p1', {}, 'd');
    await save.execute('p1', exam.id, {
      sites: [site(11, 'B', { probingMm: 4 })],
      teeth: [],
    });
    const after = await save.execute('p1', exam.id, {
      sites: [site(11, 'B')],
      teeth: [],
    });
    expect(after.sites).toEqual([]);
  });

  it('400 con mensajes en español si hay valores fuera de rango', async () => {
    const { create, save } = setup();
    const exam = await create.execute('p1', {}, 'd');
    const attempt = save.execute('p1', exam.id, {
      sites: [site(19, 'MB'), site(16, 'B', { probingMm: 25 })],
      teeth: [],
    });
    await expect(attempt).rejects.toBeInstanceOf(BadRequestException);
    await expect(attempt).rejects.toThrow(
      'Diente 19 no es un diente permanente válido (FDI 11–48). Diente 16, sitio B: el sondaje debe ser un entero entre 0 y 19 mm',
    );
  });

  it('404 si el examen no existe o es de otro paciente', async () => {
    const { create, save, get } = setup();
    const exam = await create.execute('p1', {}, 'd');
    await expect(get.execute('p2', exam.id)).rejects.toBeInstanceOf(
      NotFoundException,
    );
    await expect(
      save.execute('p1', 'nope', { sites: [], teeth: [] }),
    ).rejects.toBeInstanceOf(NotFoundException);
  });
});

describe('FinalizePerioExamUseCase', () => {
  it('finaliza y después todo cambio da 409', async () => {
    const { create, save, finalize, remove } = setup();
    const exam = await create.execute('p1', {}, 'd');
    const final = await finalize.execute('p1', exam.id);
    expect(final.status).toBe('FINAL');
    expect(final.finalizedAt).toEqual(NOW);
    await expect(
      save.execute('p1', exam.id, { sites: [], teeth: [] }),
    ).rejects.toBeInstanceOf(ConflictException);
    await expect(finalize.execute('p1', exam.id)).rejects.toBeInstanceOf(
      ConflictException,
    );
    await expect(remove.execute('p1', exam.id)).rejects.toThrow(
      'El examen está finalizado: no se puede modificar ni borrar. Para corregirlo crea un examen nuevo.',
    );
  });
});

describe('DeletePerioExamUseCase', () => {
  it('borra un DRAFT', async () => {
    const { create, remove, repo } = setup();
    const exam = await create.execute('p1', {}, 'd');
    await remove.execute('p1', exam.id);
    expect(repo.exams).toHaveLength(0);
  });
});

describe('ListPerioExamsUseCase', () => {
  it('lista por fecha descendente con índices y sin medidas', async () => {
    const { create, save, list } = setup();
    const old = await create.execute('p1', { examDate: '2026-04-10' }, 'd');
    await save.execute('p1', old.id, {
      sites: [site(16, 'MB', { probingMm: 6, bleeding: true })],
      teeth: [],
    });
    await create.execute('p1', { examDate: '2026-10-01' }, 'd');
    const rows = await list.execute('p1');
    expect(rows.map((r) => r.examDate)).toEqual(['2026-10-01', '2026-04-10']);
    expect(rows[1].indices).toMatchObject({
      bopPercent: 100,
      sites6mmOrMore: 1,
    });
    expect(rows[0]).not.toHaveProperty('sites');
  });

  it('trae como mucho los PERIO_LIST_MAX más recientes (DX-103)', async () => {
    const { create, list } = setup();
    for (let i = 0; i <= PERIO_LIST_MAX; i += 1) {
      const day = new Date(Date.UTC(2020, 0, 1 + i)).toISOString().slice(0, 10);
      await create.execute('p1', { examDate: day }, 'd');
    }
    const rows = await list.execute('p1');
    expect(rows).toHaveLength(PERIO_LIST_MAX);
    // El que queda fuera es el más antiguo.
    expect(rows.map((r) => r.examDate)).not.toContain('2020-01-01');
  });

  it('404 si el paciente es de otra clínica', async () => {
    const { list } = setup();
    await expect(list.execute('otro')).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });
});

describe('UpdatePerioNotesUseCase (DX-066)', () => {
  it('cambia las notas de un DRAFT (recortadas) y vacío o null las borra', async () => {
    const { create, notes } = setup();
    const exam = await create.execute('p1', { notes: 'Antes' }, 'd');
    expect(
      (await notes.execute('p1', exam.id, '  Control en 3 meses  ')).notes,
    ).toBe('Control en 3 meses');
    expect((await notes.execute('p1', exam.id, '   ')).notes).toBeNull();
    expect((await notes.execute('p1', exam.id, 'Otra')).notes).toBe('Otra');
    expect((await notes.execute('p1', exam.id, null)).notes).toBeNull();
  });

  it('un FINAL es inmutable: 409 con el mensaje en español y las notas no cambian', async () => {
    const { create, finalize, notes, get } = setup();
    const exam = await create.execute('p1', { notes: 'Original' }, 'd');
    await finalize.execute('p1', exam.id);
    const error = await notes
      .execute('p1', exam.id, 'Cambio')
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ConflictException);
    expect((error as ConflictException).message).toBe(PERIO_EXAM_FINAL_MESSAGE);
    expect((await get.execute('p1', exam.id)).notes).toBe('Original');
  });

  it('404 si el examen no existe o es de otro paciente', async () => {
    const { create, notes } = setup();
    const exam = await create.execute('p1', {}, 'd');
    await expect(notes.execute('p2', exam.id, 'x')).rejects.toBeInstanceOf(
      NotFoundException,
    );
    await expect(notes.execute('p1', 'nope', 'x')).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });
});

describe('ComparePerioExamsUseCase (DX-066)', () => {
  async function finals(n: number) {
    const ctx = setup();
    const ids: string[] = [];
    for (let i = 0; i < n; i += 1) {
      const exam = await ctx.create.execute(
        'p1',
        { examDate: `2026-0${i + 1}-15` },
        'd',
      );
      await ctx.save.execute('p1', exam.id, {
        sites: [site(16, 'MB', { probingMm: 3 + i * 2, recessionMm: 1 })],
        teeth: [],
      });
      await ctx.finalize.execute('p1', exam.id);
      ids.push(exam.id);
    }
    return { ...ctx, ids };
  }

  it('compara 2, 3 y 4 exámenes FINAL con Δ por sitio', async () => {
    const { compare, ids } = await finals(4);
    for (const n of [2, 3, 4]) {
      const result = await compare.execute('p1', ids.slice(0, n).reverse());
      expect(result.exams).toHaveLength(n);
      expect(result.exams[0].id).toBe(ids[0]);
      const mb = result.sites[0];
      expect(mb.values).toHaveLength(n);
      expect(mb.deltaProbingMm).toBe((n - 1) * 2);
      expect(mb.worsened).toBe(true);
      expect(mb.values[1].deltaProbingMm).toBe(2);
    }
  });

  it('los índices y los umbrales de la respuesta son los de la clínica', async () => {
    const { compare, ids, repo } = await finals(2);
    repo.perioThresholds = { pdAlertMm: 5, pdSevereMm: 7 };
    const result = await compare.execute('p1', ids);
    expect(result.thresholds).toEqual({ pdAlertMm: 5, pdSevereMm: 7 });
    expect(result.exams.map((e) => e.indices.sitesAlertOrMore)).toEqual([0, 1]);
  });

  it.each([[1], [5]])('400 con %p exámenes', async (n) => {
    const { compare, ids } = await finals(4);
    const list = n === 5 ? [...ids, 'otro'] : ids.slice(0, n);
    const error = await compare.execute('p1', list).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(BadRequestException);
    expect((error as BadRequestException).message).toBe(
      PERIO_COMPARE_MESSAGES.count,
    );
  });

  it('400 si hay un id repetido o un borrador', async () => {
    const { compare, ids, create } = await finals(2);
    await expect(compare.execute('p1', [ids[0], ids[0]])).rejects.toThrow(
      PERIO_COMPARE_MESSAGES.repeated,
    );
    const draft = await create.execute('p1', { examDate: '2026-09-01' }, 'd');
    await expect(compare.execute('p1', [ids[0], draft.id])).rejects.toThrow(
      PERIO_COMPARE_MESSAGES.notFinal,
    );
  });

  it('404 si un examen no es del paciente o el paciente es de otra clínica', async () => {
    const { compare, ids } = await finals(2);
    await expect(
      compare.execute('p1', [ids[0], 'inexistente']),
    ).rejects.toBeInstanceOf(NotFoundException);
    await expect(compare.execute('otro', ids)).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });
});

describe('Umbrales del periodontograma (DX-066)', () => {
  const ctx: AuditRequestContext = {
    tenantId: 't-1',
    locationId: null,
    actor: { userId: 'admin-1', role: 'ADMIN' },
    requestId: 'req-1',
    ip: '127.0.0.1',
    userAgent: 'jest',
  };

  function settingsSetup() {
    const { repo } = setup();
    const audit = { record: jest.fn<Promise<void>, [unknown]>() };
    return {
      repo,
      audit,
      get: new GetPerioSettingsUseCase(repo),
      update: new UpdatePerioSettingsUseCase(
        repo,
        audit as unknown as RecordAuditEventUseCase,
      ),
    };
  }

  it('de fábrica 4 y 6', async () => {
    const { get } = settingsSetup();
    await expect(get.execute()).resolves.toEqual({
      pdAlertMm: 4,
      pdSevereMm: 6,
    });
  });

  it('el cambio queda auditado con los campos y el antes y el después en código', async () => {
    const { update, audit, get } = settingsSetup();
    await expect(
      update.execute({ pdAlertMm: 5, pdSevereMm: 7 }, ctx),
    ).resolves.toEqual({ pdAlertMm: 5, pdSevereMm: 7 });
    expect(await get.execute()).toEqual({ pdAlertMm: 5, pdSevereMm: 7 });
    expect(audit.record).toHaveBeenCalledTimes(1);
    const event = audit.record.mock.calls[0][0] as {
      resourceType: string;
      action: string;
      metadata: Record<string, unknown>;
    };
    expect(event).toMatchObject({
      action: 'UPDATE',
      resourceType: 'CLINIC_SETTINGS',
      resourceId: null,
      patient: null,
    });
    // El sanitizador de la auditoría no le quita nada.
    expect(sanitizeAuditMetadata(event.metadata)).toEqual({
      reason: 'PERIO_SETTINGS',
      changedFields: ['pdAlertMm', 'pdSevereMm'],
      statusChange: { from: 'PD_A4_S6', to: 'PD_A5_S7' },
    });
  });

  it('un campo ausente conserva el actual; sin cambio no hay evento', async () => {
    const { update, audit } = settingsSetup();
    await expect(update.execute({ pdSevereMm: 8 }, ctx)).resolves.toEqual({
      pdAlertMm: 4,
      pdSevereMm: 8,
    });
    expect(audit.record).toHaveBeenCalledTimes(1);
    expect(
      (
        audit.record.mock.calls[0][0] as {
          metadata: { changedFields: string[] };
        }
      ).metadata.changedFields,
    ).toEqual(['pdSevereMm']);
    await update.execute({ pdAlertMm: 4 }, ctx);
    expect(audit.record).toHaveBeenCalledTimes(1);
  });

  it('400 en español: fuera de rango o alerta ≥ severo, sin escribir', async () => {
    const { update, get, audit } = settingsSetup();
    await expect(
      update.execute({ pdAlertMm: 6, pdSevereMm: 6 }, ctx),
    ).rejects.toThrow('El umbral de alerta debe ser menor que el severo');
    await expect(update.execute({ pdAlertMm: 7 }, ctx)).rejects.toThrow(
      'El umbral de alerta debe ser menor que el severo',
    );
    await expect(update.execute({ pdSevereMm: 20 }, ctx)).rejects.toThrow(
      'El umbral severo debe ser un entero entre 3 y 12 mm',
    );
    await expect(update.execute({ pdAlertMm: 1 }, ctx)).rejects.toBeInstanceOf(
      BadRequestException,
    );
    expect(await get.execute()).toEqual({ pdAlertMm: 4, pdSevereMm: 6 });
    expect(audit.record).not.toHaveBeenCalled();
  });

  it('el detalle y la lista cuentan con los umbrales de la clínica', async () => {
    const { repo, create, save, list } = setup();
    repo.perioThresholds = { pdAlertMm: 3, pdSevereMm: 5 };
    const exam = await create.execute('p1', {}, 'd');
    const detail = await save.execute('p1', exam.id, {
      sites: [
        site(16, 'MB', { probingMm: 3 }),
        site(16, 'B', { probingMm: 5 }),
      ],
      teeth: [],
    });
    expect(detail.thresholds).toEqual({ pdAlertMm: 3, pdSevereMm: 5 });
    expect(detail.indices).toMatchObject({
      sitesAlertOrMore: 2,
      sitesSevereOrMore: 1,
      sites4mmOrMore: 1,
      sites6mmOrMore: 0,
    });
    const [row] = await list.execute('p1');
    expect(row.indices).toEqual(detail.indices);
  });
});

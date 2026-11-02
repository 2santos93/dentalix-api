import {
  BadRequestException,
  ConflictException,
  NotFoundException,
} from '@nestjs/common';
import { patientsInClinic } from '../../../patients/application/__fixtures__/patients-in-clinic.fake';
import { InMemoryPerioExamRepository } from '../__fixtures__/in-memory-perio-exams';
import type { PerioSiteMeasure } from '../../domain/entities/perio-exam.entity';
import {
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
    // 03:00 UTC del 16 = 05:00 del 16 en Madrid (en Bogotá aún sería el 15).
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

  it('404 si el paciente es de otra clínica', async () => {
    const { list } = setup();
    await expect(list.execute('otro')).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });
});

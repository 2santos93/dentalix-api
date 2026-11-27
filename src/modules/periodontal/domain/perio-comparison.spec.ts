import { comparePerioExams, PERIO_WORSENING_MM } from './perio-comparison';
import type {
  PerioExamRecord,
  PerioSiteMeasure,
  PerioToothMeasure,
} from './entities/perio-exam.entity';

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

let seq = 0;
function exam(
  examDate: string,
  sites: PerioSiteMeasure[],
  teeth: PerioToothMeasure[] = [],
  createdAt = new Date('2026-01-01T00:00:00Z'),
): PerioExamRecord {
  seq += 1;
  return {
    id: `e${seq}`,
    tenantId: 't',
    patientId: 'p',
    providerId: 'd',
    providerName: 'Dra. Prueba',
    examDate,
    notes: null,
    status: 'FINAL',
    finalizedAt: new Date(`${examDate}T12:00:00Z`),
    createdAt,
    updatedAt: createdAt,
    sites,
    teeth,
  };
}

const T = { pdAlertMm: 4, pdSevereMm: 6 };

describe('comparePerioExams (DX-066)', () => {
  it('ordena por fecha aunque lleguen desordenados y da Δ por sitio frente al anterior y total', () => {
    const a = exam('2026-01-10', [
      site(16, 'MB', { probingMm: 3, recessionMm: 1, bleeding: true }),
      site(16, 'B', { probingMm: 4 }),
    ]);
    const b = exam('2026-04-10', [
      site(16, 'MB', { probingMm: 4, recessionMm: 1 }),
      site(16, 'B', { probingMm: 3 }),
    ]);
    const c = exam('2026-07-10', [
      site(16, 'MB', { probingMm: 5, recessionMm: 2, bleeding: true }),
      site(16, 'B', { probingMm: 2 }),
    ]);
    const result = comparePerioExams([c, a, b], T);
    expect(result.exams.map((e) => e.examDate)).toEqual([
      '2026-01-10',
      '2026-04-10',
      '2026-07-10',
    ]);
    expect(result.worseningMm).toBe(PERIO_WORSENING_MM);
    expect(result.thresholds).toEqual(T);
    const mb = result.sites.find((s) => s.site === 'MB')!;
    expect(mb.values).toEqual([
      {
        probingMm: 3,
        calMm: 4,
        bleeding: true,
        skipped: false,
        deltaProbingMm: null,
        deltaCalMm: null,
      },
      {
        probingMm: 4,
        calMm: 5,
        bleeding: false,
        skipped: false,
        deltaProbingMm: 1,
        deltaCalMm: 1,
      },
      {
        probingMm: 5,
        calMm: 7,
        bleeding: true,
        skipped: false,
        deltaProbingMm: 1,
        deltaCalMm: 2,
      },
    ]);
    expect(mb).toMatchObject({
      deltaProbingMm: 2,
      deltaCalMm: 3,
      worsened: true,
      improved: false,
    });
    const b16 = result.sites.find((s) => s.site === 'B')!;
    expect(b16).toMatchObject({
      deltaProbingMm: -2,
      worsened: false,
      improved: true,
    });
  });

  it('un Δ de 1 mm no es empeoramiento; uno de 2 sí (NIC o sondaje)', () => {
    const result = comparePerioExams(
      [
        exam('2026-01-01', [
          site(21, 'B', { probingMm: 3 }),
          site(21, 'L', { probingMm: 3, recessionMm: 0 }),
        ]),
        exam('2026-02-01', [
          site(21, 'B', { probingMm: 4 }),
          site(21, 'L', { probingMm: 3, recessionMm: 2 }),
        ]),
      ],
      T,
    );
    expect(result.sites.map((s) => [s.site, s.worsened])).toEqual([
      ['B', false],
      ['L', true],
    ]);
  });

  it('ordena los sitios por diente y por MB, B, DB, ML, L, DL', () => {
    const result = comparePerioExams(
      [
        exam('2026-01-01', [
          site(26, 'DL', { probingMm: 2 }),
          site(11, 'L', { probingMm: 2 }),
          site(11, 'MB', { probingMm: 2 }),
        ]),
        exam('2026-02-01', [site(11, 'DB', { probingMm: 2 })]),
      ],
      T,
    );
    expect(result.sites.map((s) => `${s.toothFdi}${s.site}`)).toEqual([
      '11MB',
      '11DB',
      '11L',
      '26DL',
    ]);
  });

  it('un sitio sin dato en un examen sale con nulos y sin Δ; un diente omitido no aporta sondaje', () => {
    const result = comparePerioExams(
      [
        exam('2026-01-01', [site(36, 'B', { probingMm: 5 })]),
        exam(
          '2026-02-01',
          [site(36, 'B', { probingMm: 8, bleeding: true })],
          [{ toothFdi: 36, mobility: null, skipped: true }],
        ),
        exam('2026-03-01', [site(46, 'B', { probingMm: 3 })]),
      ],
      T,
    );
    const s36 = result.sites.find((s) => s.toothFdi === 36)!;
    expect(s36.values[1]).toEqual({
      probingMm: null,
      calMm: null,
      bleeding: false,
      skipped: true,
      deltaProbingMm: null,
      deltaCalMm: null,
    });
    expect(s36.values[2].probingMm).toBeNull();
    expect(s36).toMatchObject({
      deltaProbingMm: null,
      deltaCalMm: null,
      worsened: false,
    });
  });

  it('los índices de cada examen usan los umbrales de la clínica', () => {
    const result = comparePerioExams(
      [
        exam('2026-01-01', [
          site(16, 'MB', { probingMm: 5, bleeding: true }),
          site(16, 'B', { probingMm: 7 }),
        ]),
        exam('2026-02-01', [site(16, 'MB', { probingMm: 3 })]),
      ],
      { pdAlertMm: 5, pdSevereMm: 7 },
    );
    expect(result.exams[0].indices).toMatchObject({
      sitesExamined: 2,
      bopPercent: 50,
      sitesAlertOrMore: 2,
      sitesSevereOrMore: 1,
      sites4mmOrMore: 2,
      sites6mmOrMore: 1,
    });
    expect(result.exams[1].indices.sitesAlertOrMore).toBe(0);
  });

  it('a igual fecha, va antes el creado antes', () => {
    const later = exam(
      '2026-05-05',
      [site(11, 'B', { probingMm: 5 })],
      [],
      new Date('2026-05-05T15:00:00Z'),
    );
    const earlier = exam(
      '2026-05-05',
      [site(11, 'B', { probingMm: 2 })],
      [],
      new Date('2026-05-05T09:00:00Z'),
    );
    const result = comparePerioExams([later, earlier], T);
    expect(result.exams.map((e) => e.id)).toEqual([earlier.id, later.id]);
    expect(result.sites[0].deltaProbingMm).toBe(3);
  });
});

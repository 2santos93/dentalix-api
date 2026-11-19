import {
  ACQUISITION_NO_SOURCE_LABEL,
  buildAcquisition,
  type AcquisitionCatalogSource,
} from './acquisition';

const catalog: AcquisitionCatalogSource[] = [
  {
    id: 'ref',
    name: 'Recomendación de paciente',
    kind: 'PATIENT',
    isActive: true,
    sortOrder: 10,
  },
  {
    id: 'ig',
    name: 'Instagram',
    kind: 'CHANNEL',
    isActive: true,
    sortOrder: 20,
  },
  {
    id: 'google',
    name: 'Google',
    kind: 'CHANNEL',
    isActive: true,
    sortOrder: 40,
  },
  {
    id: 'radio',
    name: 'Radio',
    kind: 'CHANNEL',
    isActive: false,
    sortOrder: 100,
  },
  {
    id: 'flyer',
    name: 'Volantes',
    kind: 'CHANNEL',
    isActive: false,
    sortOrder: 100,
  },
];

describe('buildAcquisition (DX-172)', () => {
  const report = buildAcquisition(
    catalog,
    [
      { sourceId: 'ig', newPatients: 3, payingPatients: 3 },
      { sourceId: 'google', newPatients: 1, payingPatients: 0 },
      { sourceId: 'radio', newPatients: 1, payingPatients: 1 },
      { sourceId: null, newPatients: 2, payingPatients: 1 },
    ],
    [
      { sourceId: 'ig', currency: 'VES', amount: 60000 },
      { sourceId: 'ig', currency: 'VES', amount: 40000 },
      { sourceId: 'ig', currency: 'USD', amount: 25.5 },
      { sourceId: 'radio', currency: 'USD', amount: 10 },
      { sourceId: null, currency: 'VES', amount: 100.005 },
    ],
    [
      {
        patientId: 'p2',
        fullName: 'Luis Pérez',
        patientCode: '2',
        referred: 1,
      },
      {
        patientId: 'p1',
        fullName: 'Ana Rodríguez',
        patientCode: '1',
        referred: 2,
      },
    ],
    [{ patientId: 'p1', currency: 'USD', amount: 30 }],
  );

  it('una fila por fuente activa (también con 0), las desactivadas con pacientes y «Sin dato» al final', () => {
    expect(report.rows.map((r) => [r.name, r.newPatients])).toEqual([
      ['Instagram', 3],
      // Empatadas en pacientes: primero la que más cobró.
      ['Radio', 1],
      ['Google', 1],
      ['Recomendación de paciente', 0],
      [ACQUISITION_NO_SOURCE_LABEL, 2],
    ]);
    expect(report.rows.find((r) => r.name === 'Volantes')).toBeUndefined();
    expect(report.rows.at(-1)).toMatchObject({
      sourceId: null,
      kind: null,
      isActive: null,
    });
  });

  it('lo cobrado por moneda, sin mezclar ni convertir, redondeado a 2', () => {
    expect(report.rows[0].collected).toEqual([
      { currency: 'USD', amount: 25.5 },
      { currency: 'VES', amount: 100000 },
    ]);
    expect(report.rows[2].collected).toEqual([]);
    expect(report.totals).toEqual({
      newPatients: 7,
      payingPatients: 5,
      collected: [
        { currency: 'USD', amount: 35.5 },
        { currency: 'VES', amount: 100100.01 },
      ],
    });
    expect(report.currencies).toEqual(['USD', 'VES']);
    expect(report.hasActivity).toBe(true);
  });

  it('el top de referentes por pacientes recomendados, con lo cobrado a ellos', () => {
    expect(report.topReferrers).toEqual([
      {
        patientId: 'p1',
        fullName: 'Ana Rodríguez',
        patientCode: '1',
        referred: 2,
        collected: [{ currency: 'USD', amount: 30 }],
      },
      {
        patientId: 'p2',
        fullName: 'Luis Pérez',
        patientCode: '2',
        referred: 1,
        collected: [],
      },
    ]);
  });

  it('sin pacientes nuevos: las activas a cero y sin actividad', () => {
    const empty = buildAcquisition(catalog, [], [], [], []);
    expect(empty.rows.map((r) => r.newPatients)).toEqual([0, 0, 0]);
    expect(empty.hasActivity).toBe(false);
    expect(empty.totals).toEqual({
      newPatients: 0,
      payingPatients: 0,
      collected: [],
    });
  });
});

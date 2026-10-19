import { randomUUID } from 'node:crypto';
import { sanitizeAuditMetadata } from './audit-metadata';

describe('sanitizeAuditMetadata (DX-009)', () => {
  const id = randomUUID();

  it('conserva nombres de campo, ids de la ruta y códigos', () => {
    expect(
      sanitizeAuditMetadata({
        changedFields: ['firstName', 'allergies', 'phone'],
        params: { patientId: id, fdi: '11' },
        reason: 'INVALID_CREDENTIALS',
      }),
    ).toEqual({
      changedFields: ['allergies', 'firstName', 'phone'],
      params: { patientId: id, fdi: '11' },
      reason: 'INVALID_CREDENTIALS',
    });
  });

  it('descarta cualquier clave fuera de la lista (texto clínico, firmas, importes)', () => {
    expect(
      sanitizeAuditMetadata({
        note: 'Paciente alérgica a la penicilina',
        diagnosis: 'Caries profunda',
        signaturePng: 'data:image/png;base64,iVBORw0KGgo=',
        amount: 150000,
      }),
    ).toEqual({});
  });

  it('un "nombre de campo" que no es un identificador no pasa (no se cuela texto)', () => {
    expect(
      sanitizeAuditMetadata({
        changedFields: [
          'notes',
          'alergia a la penicilina',
          'x'.repeat(65),
          42,
          'data:image/png;base64,AAAA',
        ],
      }),
    ).toEqual({ changedFields: ['notes'] });
  });

  it('un parámetro de ruta solo se guarda si es un UUID o un número corto', () => {
    expect(
      sanitizeAuditMetadata({
        params: {
          id,
          fdi: '48',
          token: 'abc.def.ghi',
          name: 'Juan Pérez',
          'bad key': id,
        },
      }),
    ).toEqual({ params: { id, fdi: '48' } });
  });

  it('un código solo es MAYÚSCULAS_CON_GUION_BAJO', () => {
    expect(sanitizeAuditMetadata({ reason: 'clave errónea' })).toEqual({});
  });

  it('acota el número de campos y quita los repetidos', () => {
    const many = Array.from({ length: 80 }, (_, i) => `field${i}`);
    const out = sanitizeAuditMetadata({
      changedFields: [...many, 'field1'],
    });
    expect(out.changedFields).toHaveLength(50);
    expect(new Set(out.changedFields).size).toBe(50);
  });

  it('lo que no es un objeto queda en {}', () => {
    expect(sanitizeAuditMetadata(null)).toEqual({});
    expect(sanitizeAuditMetadata('penicilina')).toEqual({});
    expect(sanitizeAuditMetadata(['a'])).toEqual({});
  });

  it('sin nada que guardar no deja claves vacías', () => {
    expect(sanitizeAuditMetadata({ changedFields: [], params: {} })).toEqual(
      {},
    );
  });

  describe('move (DX-121: mover una cita)', () => {
    const from = {
      start: '2031-03-03T14:00:00.000Z',
      end: '2031-03-03T14:30:00.000Z',
      providerId: '11111111-1111-4111-8111-111111111111',
    };
    const to = {
      start: '2031-03-03T15:00:00.000Z',
      end: '2031-03-03T15:30:00.000Z',
      providerId: '22222222-2222-4222-8222-222222222222',
    };

    it('guarda la hora y el profesional antes y después', () => {
      expect(sanitizeAuditMetadata({ move: { from, to } })).toEqual({
        move: { from, to },
      });
    });

    it('descarta el movimiento entero si algún valor no es una fecha ISO o un uuid', () => {
      expect(
        sanitizeAuditMetadata({
          move: { from: { ...from, start: 'mañana a las 3' }, to },
        }),
      ).toEqual({});
      expect(
        sanitizeAuditMetadata({
          move: { from, to: { ...to, providerId: 'Dra. Pérez' } },
        }),
      ).toEqual({});
      expect(sanitizeAuditMetadata({ move: 'x' })).toEqual({});
    });

    it('no deja pasar claves de más dentro del movimiento', () => {
      expect(
        sanitizeAuditMetadata({
          move: { from: { ...from, notes: 'alergia' }, to },
        }),
      ).toEqual({ move: { from, to } });
    });
  });

  describe('status (DX-200: flujo del paciente en la clínica)', () => {
    it('guarda los códigos de estado antes y después', () => {
      expect(
        sanitizeAuditMetadata({
          reason: 'PATIENT_FLOW',
          status: { from: 'CONFIRMED', to: 'ARRIVED' },
        }),
      ).toEqual({
        reason: 'PATIENT_FLOW',
        status: { from: 'CONFIRMED', to: 'ARRIVED' },
      });
    });

    it('descarta el cambio entero si alguno no es un código', () => {
      expect(
        sanitizeAuditMetadata({
          status: { from: 'CONFIRMED', to: 'llegó tarde' },
        }),
      ).toEqual({});
      expect(sanitizeAuditMetadata({ status: { from: 'ARRIVED' } })).toEqual(
        {},
      );
    });
  });

  describe('origin (DX-128: de dónde salió un cambio de comunicación)', () => {
    it.each(['IN_PERSON', 'LINK', 'MESSAGE', 'STAFF', 'JOB'])(
      'guarda %s',
      (origin) => {
        expect(sanitizeAuditMetadata({ origin })).toEqual({ origin });
      },
    );

    it('descarta cualquier otro valor', () => {
      expect(sanitizeAuditMetadata({ origin: 'WEBHOOK' })).toEqual({});
      expect(sanitizeAuditMetadata({ origin: '+573101234567' })).toEqual({});
      expect(sanitizeAuditMetadata({ origin: 1 })).toEqual({});
    });
  });

  describe('search (DX-191: búsqueda de implantes por lote/REF)', () => {
    it('guarda lote, REF y nº de filas', () => {
      expect(
        sanitizeAuditMetadata({
          search: { lot: 'LOT-AB12', reference: '021.5310', rows: 2 },
        }),
      ).toEqual({
        search: { lot: 'LOT-AB12', reference: '021.5310', rows: 2 },
      });
    });

    it('descarta lo que no es un código y exige un nº de filas', () => {
      expect(
        sanitizeAuditMetadata({
          search: { lot: 'Ana Gómez <script>', reference: 12, rows: 0 },
        }),
      ).toEqual({ search: { rows: 0 } });
      expect(sanitizeAuditMetadata({ search: { lot: 'LOT-1' } })).toEqual({});
      expect(
        sanitizeAuditMetadata({ search: { lot: 'LOT-1', rows: -1 } }),
      ).toEqual({});
    });
  });
  describe('statusChange (DX-215: compromiso reabierto al anular su abono)', () => {
    it('guarda el estado anterior y el nuevo', () => {
      expect(
        sanitizeAuditMetadata({ statusChange: { from: 'KEPT', to: 'OPEN' } }),
      ).toEqual({ statusChange: { from: 'KEPT', to: 'OPEN' } });
    });

    it('descarta el cambio entero si algún lado no es un código, y las claves de más', () => {
      expect(
        sanitizeAuditMetadata({
          statusChange: { from: 'KEPT', to: 'Paga el viernes' },
        }),
      ).toEqual({});
      expect(sanitizeAuditMetadata({ statusChange: { from: 'KEPT' } })).toEqual(
        {},
      );
      expect(
        sanitizeAuditMetadata({
          statusChange: { from: 'KEPT', to: 'BROKEN', amount: 200000 },
        }),
      ).toEqual({ statusChange: { from: 'KEPT', to: 'BROKEN' } });
    });
  });
});

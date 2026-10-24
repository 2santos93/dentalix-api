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

  describe('scheduleChange (DX-233: horario de un profesional)', () => {
    const loc = randomUUID();

    it('guarda los tramos antes y después (semanal y excepción)', () => {
      const change = {
        before: [
          { locationId: loc, weekday: 1, startMinute: 480, endMinute: 780 },
        ],
        after: [
          { locationId: loc, date: '2026-10-22', off: true },
          {
            locationId: loc,
            date: '2026-10-23',
            startMinute: 540,
            endMinute: 600,
          },
        ],
      };
      expect(sanitizeAuditMetadata({ scheduleChange: change })).toEqual({
        scheduleChange: change,
      });
    });

    it('descarta el cambio entero si un tramo no tiene la forma admitida', () => {
      for (const bad of [
        { locationId: 'no-uuid', weekday: 1, startMinute: 0, endMinute: 60 },
        { locationId: loc, weekday: 8, startMinute: 0, endMinute: 60 },
        { locationId: loc, weekday: 1, startMinute: 0, endMinute: 2000 },
        { locationId: loc, startMinute: 0, endMinute: 60 },
        {
          locationId: loc,
          weekday: 1,
          date: '2026-10-22',
          startMinute: 0,
          endMinute: 60,
        },
        { locationId: loc, weekday: 1, off: true },
        { locationId: loc, date: 'mañana', off: true },
      ]) {
        expect(
          sanitizeAuditMetadata({
            scheduleChange: { before: [], after: [bad] },
          }),
        ).toEqual({});
      }
    });

    it('no deja pasar claves de más dentro de un tramo', () => {
      expect(
        sanitizeAuditMetadata({
          scheduleChange: {
            before: [],
            after: [
              {
                locationId: loc,
                weekday: 2,
                startMinute: 60,
                endMinute: 120,
                note: 'Cubre a la Dra. Ruiz',
              },
            ],
          },
        }),
      ).toEqual({
        scheduleChange: {
          before: [],
          after: [
            { locationId: loc, weekday: 2, startMinute: 60, endMinute: 120 },
          ],
        },
      });
    });
  });
});

describe('sanitizeAuditMetadata — lote de importación (DX-107)', () => {
  const sha = 'a'.repeat(64);

  it('deja el hash, el modo y los contadores enteros ≥ 0', () => {
    expect(
      sanitizeAuditMetadata({
        importBatch: {
          fileSha256: sha,
          mode: 'FILL_EMPTY',
          rows: 10,
          valid: 7,
          duplicates: 2,
          errors: 1,
          created: 0,
          updated: -1,
          undoneCreated: 1.5,
          fileName: 'pacientes-juan.xlsx',
        },
      }),
    ).toEqual({
      importBatch: {
        fileSha256: sha,
        mode: 'FILL_EMPTY',
        rows: 10,
        valid: 7,
        duplicates: 2,
        errors: 1,
        created: 0,
      },
    });
  });

  it('sin un hash válido no guarda nada del lote', () => {
    expect(
      sanitizeAuditMetadata({
        importBatch: { fileSha256: 'Ana Pérez', rows: 3 },
      }),
    ).toEqual({});
    expect(sanitizeAuditMetadata({ importBatch: 'x' })).toEqual({});
  });
});

describe('sanitizeAuditMetadata — saldos migrados del lote (DX-262)', () => {
  const sha = 'a'.repeat(64);
  const bsha = 'b'.repeat(64);

  it('deja el hash de la hoja de saldos, sus contadores y los totales por moneda', () => {
    expect(
      sanitizeAuditMetadata({
        importBatch: {
          fileSha256: sha,
          balanceFileSha256: bsha,
          balanceRows: 12,
          balanceErrors: 2,
          balancesCreated: 9,
          balancesUndone: -1,
          balanceTotals: [
            { currency: 'COP', rows: 9, amount: 1500000.5, docNumber: '123' },
            { currency: 'usd', rows: 1, amount: 10 },
            { currency: 'EUR', rows: 1, amount: 10.555 },
            { currency: 'USD', rows: 1, amount: 40 },
          ],
          balanceUndoneTotals: [{ currency: 'COP', rows: 2, amount: 10.5 }],
        },
      }),
    ).toEqual({
      importBatch: {
        fileSha256: sha,
        balanceFileSha256: bsha,
        balanceRows: 12,
        balanceErrors: 2,
        balancesCreated: 9,
        balanceTotals: [
          { currency: 'COP', rows: 9, amount: 1500000.5 },
          { currency: 'USD', rows: 1, amount: 40 },
        ],
        balanceUndoneTotals: [{ currency: 'COP', rows: 2, amount: 10.5 }],
      },
    });
  });

  it('QA D1: «Añadir aunque ya tenga saldo migrado» (solo booleano) y los no creados por eso', () => {
    expect(
      sanitizeAuditMetadata({
        importBatch: {
          fileSha256: sha,
          balanceAddToExisting: true,
          balancesExisting: 2,
        },
      }),
    ).toEqual({
      importBatch: {
        fileSha256: sha,
        balanceAddToExisting: true,
        balancesExisting: 2,
      },
    });
    expect(
      sanitizeAuditMetadata({
        importBatch: { fileSha256: sha, balanceAddToExisting: 'sí' },
      }),
    ).toEqual({ importBatch: { fileSha256: sha } });
  });

  it('un hash de la hoja que no es SHA-256 se descarta', () => {
    expect(
      sanitizeAuditMetadata({
        importBatch: { fileSha256: sha, balanceFileSha256: 'saldos.csv' },
      }),
    ).toEqual({ importBatch: { fileSha256: sha } });
  });
});

describe('sanitizeAuditMetadata — mínimo de la visita siguiente (DX-273)', () => {
  const plan = '0192f1a0-0000-7000-8000-000000000001';

  it('conserva plan, visita y días civiles (o null) antes y después', () => {
    expect(
      sanitizeAuditMetadata({
        visitMinimums: [
          {
            planId: plan.toUpperCase(),
            visit: 2,
            before: '2027-01-20',
            after: null,
          },
          { planId: plan, visit: 3, before: null, after: '2027-02-01' },
        ],
      }),
    ).toEqual({
      visitMinimums: [
        { planId: plan, visit: 2, before: '2027-01-20', after: null },
        { planId: plan, visit: 3, before: null, after: '2027-02-01' },
      ],
    });
  });

  it('una entrada con otra forma se descarta entera (sin texto libre)', () => {
    expect(
      sanitizeAuditMetadata({
        visitMinimums: [
          { planId: 'Ana Pérez', visit: 2, before: null, after: null },
          { planId: plan, visit: 0, before: null, after: null },
          { planId: plan, visit: 2, before: 'mañana', after: null },
          { planId: plan, visit: 2, before: null, after: null, note: 'x' },
          { planId: plan, visit: 2, before: null, after: null },
        ],
      }),
    ).toEqual({
      visitMinimums: [{ planId: plan, visit: 2, before: null, after: null }],
    });
    expect(sanitizeAuditMetadata({ visitMinimums: 'x' })).toEqual({});
    expect(
      sanitizeAuditMetadata({
        visitMinimums: Array.from({ length: 60 }, (_, i) => ({
          planId: plan,
          visit: i + 1,
          before: null,
          after: null,
        })),
      }).visitMinimums,
    ).toHaveLength(50);
  });
});

describe('sanitizeAuditMetadata — atribución del ítem realizado (DX-050)', () => {
  const dentist = '11111111-2222-4333-8444-555555555555';
  const location = '66666666-7777-4888-8999-000000000000';

  it('conserva quién, sede e instante antes y después (o null)', () => {
    expect(
      sanitizeAuditMetadata({
        attribution: {
          before: {
            performedById: dentist.toUpperCase(),
            locationId: location,
            completedAt: '2026-10-20T15:00:00.000Z',
          },
          after: { performedById: null, locationId: null, completedAt: null },
        },
      }),
    ).toEqual({
      attribution: {
        before: {
          performedById: dentist,
          locationId: location,
          completedAt: '2026-10-20T15:00:00.000Z',
        },
        after: { performedById: null, locationId: null, completedAt: null },
      },
    });
  });

  it('descarta el cambio entero si un lado no tiene la forma admitida', () => {
    const after = { performedById: null, locationId: null, completedAt: null };
    for (const before of [
      { performedById: 'Dra. Ana', locationId: null, completedAt: null },
      { performedById: null, locationId: null, completedAt: 'ayer' },
      { performedById: null, locationId: null, completedAt: null, note: 'x' },
      { performedById: null, locationId: null },
    ]) {
      expect(sanitizeAuditMetadata({ attribution: { before, after } })).toEqual(
        {},
      );
    }
    expect(sanitizeAuditMetadata({ attribution: 'x' })).toEqual({});
  });
});

describe('sanitizeAuditMetadata — cancelación de una cita (DX-279)', () => {
  it('conserva origen, código del motivo, minutos de aviso y si fue tardía', () => {
    const cancellation = {
      byKind: 'STAFF_FOR_PATIENT',
      reasonCode: 'ILLNESS',
      noticeMinutes: 300,
      lateCancellation: true,
    };
    expect(sanitizeAuditMetadata({ cancellation })).toEqual({ cancellation });
    expect(
      sanitizeAuditMetadata({
        cancellation: {
          ...cancellation,
          byKind: 'PATIENT_LINK',
          reasonCode: null,
        },
      }),
    ).toEqual({
      cancellation: {
        ...cancellation,
        byKind: 'PATIENT_LINK',
        reasonCode: null,
      },
    });
  });

  it('descarta la cancelación entera con texto libre, códigos ajenos o números raros', () => {
    const base = {
      byKind: 'CLINIC',
      reasonCode: 'CLINIC_RESCHEDULE',
      noticeMinutes: 60,
      lateCancellation: false,
    };
    for (const cancellation of [
      { ...base, reasonText: 'Tiene gripe' },
      { ...base, byKind: 'OTRO' },
      { ...base, reasonCode: 'Gripe' },
      { ...base, noticeMinutes: -1 },
      { ...base, noticeMinutes: 1.5 },
      { ...base, lateCancellation: 'sí' },
    ]) {
      expect(sanitizeAuditMetadata({ cancellation })).toEqual({});
    }
  });
});

describe('sanitizeAuditMetadata — nº de registro sanitario de la sede (DX-319)', () => {
  it('conserva el número (o null) y si se imprime, antes y después', () => {
    const healthRegistration = {
      before: { number: '110010123401', shown: false },
      after: { number: 'NRS 28/1234-AB', shown: true },
    };
    expect(sanitizeAuditMetadata({ healthRegistration })).toEqual({
      healthRegistration,
    });
    const cleared = {
      before: { number: 'NRS-1', shown: true },
      after: { number: null, shown: false },
    };
    expect(sanitizeAuditMetadata({ healthRegistration: cleared })).toEqual({
      healthRegistration: cleared,
    });
  });

  it('descarta el cambio entero si un lado no tiene la forma admitida', () => {
    const ok = { number: 'NRS-1', shown: false };
    for (const healthRegistration of [
      { before: ok },
      { before: ok, after: { number: 'A'.repeat(65), shown: true } },
      { before: ok, after: { number: 'NRS\n2', shown: true } },
      { before: ok, after: { number: '', shown: true } },
      { before: ok, after: { number: 12, shown: true } },
      { before: ok, after: { number: 'NRS-2', shown: 'sí' } },
      { before: ok, after: { number: 'NRS-2', shown: true, extra: 'x' } },
    ]) {
      expect(sanitizeAuditMetadata({ healthRegistration })).toEqual({});
    }
  });
});

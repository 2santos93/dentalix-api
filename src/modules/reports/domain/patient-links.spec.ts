import {
  hoursOneDecimal,
  PATIENT_LINK_TYPES,
  patientLinkMetrics,
  patientLinkRows,
  percentOfSent,
} from './patient-links';

describe('Enlaces del paciente — métricas (DX-424)', () => {
  it('tasas sobre los enviados, en % con 1 decimal; sin envíos, null', () => {
    expect(percentOfSent(1, 3)).toBe(33.3);
    expect(percentOfSent(2, 3)).toBe(66.7);
    expect(percentOfSent(1, 6)).toBe(16.7);
    expect(percentOfSent(3, 3)).toBe(100);
    expect(percentOfSent(0, 4)).toBe(0);
    expect(percentOfSent(0, 0)).toBeNull();
  });

  it('horas con 1 decimal', () => {
    expect(hoursOneDecimal(3 * 3600)).toBe(3);
    expect(hoursOneDecimal(5400)).toBe(1.5);
    expect(hoursOneDecimal(1234)).toBe(0.3);
    expect(hoursOneDecimal(null)).toBeNull();
    expect(hoursOneDecimal(Number.NaN)).toBeNull();
  });

  it('firma: todas las señales', () => {
    expect(
      patientLinkMetrics('CONSENT_SIGNATURE', {
        sent: 6,
        opened: 2,
        completed: 1,
        expiredUnopened: 2,
        medianSecondsToComplete: 3 * 3600,
      }),
    ).toEqual({
      linkType: 'CONSENT_SIGNATURE',
      tracksOpened: true,
      tracksCompleted: true,
      sent: 6,
      opened: 2,
      completed: 1,
      expiredUnopened: 2,
      openedRate: 33.3,
      completedRate: 16.7,
      expiredUnopenedRate: 33.3,
      medianHoursToComplete: 3,
    });
  });

  it('confirmación de cita: sin apertura, abiertos y «sin abrir» en null (nunca un cero inventado)', () => {
    const m = patientLinkMetrics('APPOINTMENT_CONFIRMATION', {
      sent: 4,
      opened: 0,
      completed: 3,
      expiredUnopened: 0,
      medianSecondsToComplete: 7200,
    });
    expect(m).toMatchObject({
      tracksOpened: false,
      opened: null,
      openedRate: null,
      expiredUnopened: null,
      expiredUnopenedRate: null,
      completed: 3,
      completedRate: 75,
      medianHoursToComplete: 2,
    });
  });

  it('indicaciones: sin «completado» ni mediana', () => {
    const m = patientLinkMetrics('POST_OP_INSTRUCTIONS', {
      sent: 2,
      opened: 1,
      completed: 0,
      expiredUnopened: 1,
      medianSecondsToComplete: null,
    });
    expect(m).toMatchObject({
      tracksCompleted: false,
      completed: null,
      completedRate: null,
      medianHoursToComplete: null,
      openedRate: 50,
      expiredUnopenedRate: 50,
    });
  });

  it('sin envíos: ceros y tasas null', () => {
    const rows = patientLinkRows(new Map());
    expect(rows.map((r) => r.linkType)).toEqual([...PATIENT_LINK_TYPES]);
    for (const r of rows) {
      expect(r.sent).toBe(0);
      expect(r.openedRate).toBeNull();
      expect(r.completedRate).toBeNull();
      expect(r.expiredUnopenedRate).toBeNull();
      expect(r.medianHoursToComplete).toBeNull();
    }
  });
});

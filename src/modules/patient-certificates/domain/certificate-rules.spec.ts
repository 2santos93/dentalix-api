import { AppointmentStatus, ClinicRole } from '@prisma/client';
import {
  attendanceTimes,
  canIssue,
  canSeeDiagnosis,
  canVoid,
  checkRest,
  formatCertificateNumber,
  isValidRestMaxDays,
  normalizeVoidReason,
  notAttendedMessage,
  restErrorMessage,
  type RestRuleContext,
} from './certificate-rules';

const { RECEPTION, DENTIST, ASSISTANT, ADMIN } = ClinicRole;

const ctx = (over: Partial<RestRuleContext> = {}): RestRuleContext => ({
  maxDays: 30,
  printDiagnosis: false,
  attentionDay: '2026-11-16',
  professionalLicense: 'MPPS 45678',
  ...over,
});

describe('reglas de los certificados (DX-306)', () => {
  describe('rol', () => {
    it.each([RECEPTION, DENTIST, ASSISTANT, ADMIN])(
      'el justificante lo emite %s',
      (role) => expect(canIssue('ATTENDANCE', role)).toBe(true),
    );
    it.each([
      [DENTIST, true],
      [ADMIN, true],
      [ASSISTANT, false],
      [RECEPTION, false],
    ])('el reposo lo emite %s: %s', (role, expected) =>
      expect(canIssue('REST', role)).toBe(expected),
    );

    it('el diagnóstico lo ven los roles clínicos y quien emitió, no recepción', () => {
      const cert = { issuedById: 'u-dentist' };
      expect(canSeeDiagnosis({ userId: 'x', role: ASSISTANT }, cert)).toBe(
        true,
      );
      expect(canSeeDiagnosis({ userId: 'x', role: RECEPTION }, cert)).toBe(
        false,
      );
      expect(
        canSeeDiagnosis({ userId: 'u-dentist', role: RECEPTION }, cert),
      ).toBe(true);
    });

    it('anula quien lo emitió (si aún lo emite) o ADMIN', () => {
      const att = { issuedById: 'u-rec', kind: 'ATTENDANCE' as const };
      expect(canVoid({ userId: 'u-rec', role: RECEPTION }, att)).toBe(true);
      expect(canVoid({ userId: 'otro', role: RECEPTION }, att)).toBe(false);
      expect(canVoid({ userId: 'otro', role: ADMIN }, att)).toBe(true);
      const rest = { issuedById: 'u-den', kind: 'REST' as const };
      expect(canVoid({ userId: 'u-den', role: DENTIST }, rest)).toBe(true);
      // Ya no tiene un rol que emita el reposo.
      expect(canVoid({ userId: 'u-den', role: ASSISTANT }, rest)).toBe(false);
    });
  });

  describe('cita atendida', () => {
    it('solo COMPLETED', () => {
      expect(notAttendedMessage(AppointmentStatus.COMPLETED)).toBeNull();
      for (const status of Object.values(AppointmentStatus)) {
        if (status === AppointmentStatus.COMPLETED) continue;
        expect(notAttendedMessage(status)).toMatch(
          /^Solo se emite para una cita atendida: esta cita está /,
        );
      }
      expect(notAttendedMessage(AppointmentStatus.NO_SHOW)).toContain(
        'inasistencia',
      );
    });
  });

  describe('horas del justificante', () => {
    const start = new Date('2026-11-16T13:00:00Z');
    const end = new Date('2026-11-16T13:30:00Z');
    const arrivedAt = new Date('2026-11-16T12:52:00Z');
    const completedAt = new Date('2026-11-16T13:41:00Z');

    it('reales con llegada y salida', () => {
      expect(attendanceTimes({ start, end, arrivedAt, completedAt })).toEqual({
        from: arrivedAt,
        until: completedAt,
        source: 'ACTUAL',
      });
    });

    it.each([
      ['sin llegada', null, completedAt],
      ['sin salida', arrivedAt, null],
      ['salida antes que llegada', completedAt, arrivedAt],
    ])('programadas %s', (_label, a, c) => {
      expect(
        attendanceTimes({ start, end, arrivedAt: a, completedAt: c }),
      ).toEqual({ from: start, until: end, source: 'SCHEDULED' });
    });
  });

  describe('reposo', () => {
    it('días válidos: fin = inicio + días − 1, inicio por defecto el día de la atención', () => {
      expect(checkRest({ restDays: 3 }, ctx())).toEqual({
        ok: true,
        value: {
          restDays: 3,
          restStartDate: '2026-11-16',
          restEndDate: '2026-11-18',
          diagnosis: null,
        },
      });
      expect(
        checkRest({ restDays: 1, restStartDate: '2026-11-17' }, ctx()),
      ).toMatchObject({
        ok: true,
        value: { restStartDate: '2026-11-17', restEndDate: '2026-11-17' },
      });
    });

    it.each([0, -1, 31, 2.5, '3', null, undefined])(
      'días fuera de 1..máximo (%p)',
      (days) => {
        const r = checkRest({ restDays: days }, ctx());
        expect(r.ok).toBe(false);
        if (!r.ok)
          expect(r.errors).toContain(
            'los días de reposo deben ser un número entero entre 1 y 30',
          );
      },
    );

    it('el máximo es el de la clínica', () => {
      expect(checkRest({ restDays: 7 }, ctx({ maxDays: 5 })).ok).toBe(false);
      expect(checkRest({ restDays: 5 }, ctx({ maxDays: 5 })).ok).toBe(true);
    });

    it('sin registro profesional: 400 que lo dice (junto con lo demás)', () => {
      const r = checkRest({ restDays: 99 }, ctx({ professionalLicense: '  ' }));
      expect(r.ok).toBe(false);
      if (r.ok) return;
      expect(r.errors).toHaveLength(2);
      expect(restErrorMessage(r.errors)).toBe(
        'No se puede emitir el certificado de reposo: falta tu número de registro profesional (lo añade un administrador en Personal); los días de reposo deben ser un número entero entre 1 y 30.',
      );
    });

    it('inicio no anterior a la atención ni más de 30 días después', () => {
      const before = checkRest(
        { restDays: 2, restStartDate: '2026-11-15' },
        ctx(),
      );
      expect(before).toEqual({
        ok: false,
        errors: ['el reposo no puede empezar antes del día de la atención'],
      });
      expect(
        checkRest({ restDays: 2, restStartDate: '2026-12-16' }, ctx()).ok,
      ).toBe(true);
      expect(
        checkRest({ restDays: 2, restStartDate: '2026-12-17' }, ctx()).ok,
      ).toBe(false);
      expect(
        checkRest({ restDays: 2, restStartDate: '2026-02-30' }, ctx()),
      ).toEqual({
        ok: false,
        errors: ['la fecha de inicio del reposo no es válida (AAAA-MM-DD)'],
      });
    });

    it('diagnóstico solo si la clínica lo imprime; vacío = sin diagnóstico', () => {
      expect(
        checkRest({ restDays: 2, diagnosis: 'Exodoncia' }, ctx()),
      ).toMatchObject({ ok: false });
      expect(checkRest({ restDays: 2, diagnosis: '   ' }, ctx())).toMatchObject(
        { ok: true, value: { diagnosis: null } },
      );
      expect(
        checkRest(
          { restDays: 2, diagnosis: '  Exodoncia del 38  ' },
          ctx({ printDiagnosis: true }),
        ),
      ).toMatchObject({ ok: true, value: { diagnosis: 'Exodoncia del 38' } });
      expect(
        checkRest(
          { restDays: 2, diagnosis: 'x'.repeat(501) },
          ctx({ printDiagnosis: true }),
        ).ok,
      ).toBe(false);
    });
  });

  it('ajustes, motivo y número', () => {
    expect(isValidRestMaxDays(1)).toBe(true);
    expect(isValidRestMaxDays(365)).toBe(true);
    expect(isValidRestMaxDays(0)).toBe(false);
    expect(isValidRestMaxDays(366)).toBe(false);
    expect(isValidRestMaxDays(1.5)).toBe(false);
    expect(normalizeVoidReason('  Fecha equivocada ')).toBe('Fecha equivocada');
    expect(normalizeVoidReason('ab')).toBeNull();
    expect(normalizeVoidReason(42)).toBeNull();
    expect(formatCertificateNumber(7)).toBe('000007');
    expect(formatCertificateNumber(1234567)).toBe('1234567');
  });
});

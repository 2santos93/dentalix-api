import { ClinicRole } from '@prisma/client';
import {
  checkClosingPeriod,
  checkDismissal,
  CLOSING_QUEUE_DEFAULT_DAYS,
  closingProfessional,
  closingWindow,
  sectionsFor,
} from './closing-queue-rules';

describe('«Pendiente de cerrar» — reglas (DX-439)', () => {
  describe('secciones por rol', () => {
    it('ADMIN ve las tres; DENTIST, evolución y tratamiento; RECEPTION, el desenlace', () => {
      expect(sectionsFor(ClinicRole.ADMIN)).toEqual([
        'OUTCOME',
        'EVOLUTION',
        'TREATMENT',
      ]);
      expect(sectionsFor(ClinicRole.DENTIST)).toEqual([
        'EVOLUTION',
        'TREATMENT',
      ]);
      expect(sectionsFor(ClinicRole.RECEPTION)).toEqual(['OUTCOME']);
      expect(sectionsFor(ClinicRole.ASSISTANT)).toEqual([]);
    });
  });

  describe('profesional', () => {
    const dentist = { userId: 'u-1', role: ClinicRole.DENTIST };
    it('el DENTIST queda fijado a sí mismo aunque no lo pida', () => {
      expect(closingProfessional(dentist, undefined)).toEqual({
        ok: true,
        professionalId: 'u-1',
      });
      expect(closingProfessional(dentist, 'u-1')).toEqual({
        ok: true,
        professionalId: 'u-1',
      });
    });
    it('el DENTIST que pide otro profesional: OWN_ONLY', () => {
      expect(closingProfessional(dentist, 'u-2')).toEqual({ ok: false });
    });
    it('ADMIN y RECEPTION filtran por quien pidan, o por nadie', () => {
      for (const role of [ClinicRole.ADMIN, ClinicRole.RECEPTION]) {
        expect(closingProfessional({ userId: 'x', role }, 'u-2')).toEqual({
          ok: true,
          professionalId: 'u-2',
        });
        expect(closingProfessional({ userId: 'x', role }, undefined)).toEqual({
          ok: true,
        });
      }
    });
  });

  describe('período', () => {
    it('sin fechas vale (por defecto); con fechas, AAAA-MM-DD y desde ≤ hasta', () => {
      expect(checkClosingPeriod(undefined, undefined, '2026-11-01')).toEqual({
        ok: true,
      });
      expect(
        checkClosingPeriod('2026-10-01', '2026-10-30', '2026-11-01'),
      ).toEqual({
        ok: true,
        from: '2026-10-01',
        to: '2026-10-30',
      });
      expect(
        checkClosingPeriod('2026-10-30', '2026-10-01', '2026-11-01'),
      ).toEqual({
        ok: false,
        problem: 'INVALID',
      });
      expect(checkClosingPeriod('30/10/2026', undefined, '2026-11-01')).toEqual(
        {
          ok: false,
          problem: 'INVALID',
        },
      );
    });
    it('con un solo extremo, el tope de 92 días también vale contra hoy', () => {
      const today = '2026-11-01';
      // Del 31/07 a ayer (31/10) son 93 días; del 01/08, 92.
      expect(checkClosingPeriod('2026-07-31', undefined, today)).toEqual({
        ok: false,
        problem: 'TOO_LONG',
      });
      expect(checkClosingPeriod('2026-08-01', undefined, today)).toEqual({
        ok: true,
        from: '2026-08-01',
      });
      // Solo «hasta»: el «desde» por defecto (hasta − 14) nunca pasa del tope.
      expect(checkClosingPeriod(undefined, '2026-06-01', today)).toEqual({
        ok: true,
        to: '2026-06-01',
      });
    });

    it('como mucho 92 días', () => {
      expect(
        checkClosingPeriod('2026-01-01', '2026-04-02', '2026-11-01'),
      ).toEqual({
        ok: true,
        from: '2026-01-01',
        to: '2026-04-02',
      });
      expect(
        checkClosingPeriod('2026-01-01', '2026-04-03', '2026-11-01'),
      ).toEqual({
        ok: false,
        problem: 'TOO_LONG',
      });
    });
  });

  describe('ventana por zona de la sede', () => {
    const zones = new Map([
      ['caracas', 'America/Caracas'],
      ['madrid', 'Europe/Madrid'],
    ]);

    it(`por defecto, los ${CLOSING_QUEUE_DEFAULT_DAYS} días hasta AYER en la zona de cada sede`, () => {
      // 01/11 00:30 UTC: en Caracas (UTC−4) aún es 31/10; en Madrid (UTC+1), 01/11.
      const now = new Date('2026-11-01T00:30:00Z');
      const branches = closingWindow(now, zones, {});
      const caracas = branches.find((b) => b.timeZone === 'America/Caracas');
      const madrid = branches.find((b) => b.timeZone === 'Europe/Madrid');
      // Caracas: del 17/10 al 30/10; hoy (31/10) empieza a las 04:00Z.
      expect(caracas).toEqual({
        timeZone: 'America/Caracas',
        locationIds: ['caracas'],
        start: new Date('2026-10-17T04:00:00Z'),
        end: new Date('2026-10-31T04:00:00Z'),
      });
      // Madrid: del 18/10 al 31/10; hoy (01/11) empieza a las 23:00Z del 31/10
      // (ya en horario de invierno, UTC+1).
      expect(madrid).toEqual({
        timeZone: 'Europe/Madrid',
        locationIds: ['madrid'],
        start: new Date('2026-10-17T22:00:00Z'),
        end: new Date('2026-10-31T23:00:00Z'),
      });
    });

    it('«hasta» nunca pasa de ayer: hoy no sale aunque se pida', () => {
      const now = new Date('2026-11-01T00:30:00Z');
      const [caracas] = closingWindow(
        now,
        new Map([['caracas', 'America/Caracas']]),
        { from: '2026-10-30', to: '2026-11-05' },
      );
      expect(caracas.start).toEqual(new Date('2026-10-30T04:00:00Z'));
      expect(caracas.end).toEqual(new Date('2026-10-31T04:00:00Z'));
    });

    it('solo «hasta»: los 14 días que acaban en él', () => {
      const now = new Date('2026-11-01T00:30:00Z');
      const [caracas] = closingWindow(
        now,
        new Map([['caracas', 'America/Caracas']]),
        { to: '2026-10-20' },
      );
      expect(caracas.start).toEqual(new Date('2026-10-07T04:00:00Z'));
      expect(caracas.end).toEqual(new Date('2026-10-21T04:00:00Z'));
    });

    it('con tope, un «desde» lejano se recorta a 92 días en la zona de la rama', () => {
      const now = new Date('2026-11-01T00:30:00Z');
      const [caracas] = closingWindow(
        now,
        new Map([['caracas', 'America/Caracas']]),
        { from: '2026-01-01' },
        92,
      );
      // Ayer en Caracas = 30/10; 92 días acaban ahí y empiezan el 31/07.
      expect(caracas.start).toEqual(new Date('2026-07-31T04:00:00Z'));
    });

    it('un período que empieza hoy o después no deja rama en esa zona', () => {
      const now = new Date('2026-11-01T00:30:00Z');
      const branches = closingWindow(now, zones, {
        from: '2026-11-01',
        to: '2026-11-01',
      });
      // Caracas: hoy es 31/10, así que el 01/11 es futuro. Madrid: es hoy.
      expect(branches).toEqual([]);
    });

    it('sin sedes, sin ramas', () => {
      expect(closingWindow(new Date(), new Map(), {})).toEqual([]);
    });
  });

  describe('descarte', () => {
    const base = {
      section: 'EVOLUTION' as const,
      appointmentId: 'a-1',
      reasonCode: 'PAPER_NOTE' as const,
    };

    it('un motivo de la lista basta; el texto solo se guarda con «Otro»', () => {
      expect(checkDismissal({ ...base, reasonText: 'algo' })).toEqual({
        ok: true,
        value: { ...base, planItemId: null, reasonText: null },
      });
    });

    it('«Otro» exige texto de 3 a 200 caracteres (sin contar los bordes)', () => {
      const other = { ...base, reasonCode: 'OTHER' as const };
      expect(checkDismissal(other)).toEqual({
        ok: false,
        problem: 'REASON_TEXT',
      });
      expect(checkDismissal({ ...other, reasonText: '  ab  ' })).toEqual({
        ok: false,
        problem: 'REASON_TEXT',
      });
      expect(checkDismissal({ ...other, reasonText: 'x'.repeat(201) })).toEqual(
        { ok: false, problem: 'REASON_TEXT' },
      );
      expect(
        checkDismissal({ ...other, reasonText: '  Se registra mañana ' }),
      ).toEqual({
        ok: true,
        value: { ...other, planItemId: null, reasonText: 'Se registra mañana' },
      });
    });

    it('«Otro» cuenta caracteres, no unidades UTF-16 (como char_length en la BD)', () => {
      const other = { ...base, reasonCode: 'OTHER' as const };
      expect(checkDismissal({ ...other, reasonText: '👍👍' })).toEqual({
        ok: false,
        problem: 'REASON_TEXT',
      });
      expect(checkDismissal({ ...other, reasonText: '👍👍👍' })).toEqual({
        ok: true,
        value: { ...other, planItemId: null, reasonText: '👍👍👍' },
      });
      expect(
        checkDismissal({ ...other, reasonText: '👍'.repeat(200) }),
      ).toEqual({
        ok: true,
        value: { ...other, planItemId: null, reasonText: '👍'.repeat(200) },
      });
      expect(
        checkDismissal({ ...other, reasonText: '👍'.repeat(201) }),
      ).toEqual({ ok: false, problem: 'REASON_TEXT' });
    });

    it('el tratamiento lleva su ítem; las otras secciones, no', () => {
      expect(checkDismissal({ ...base, section: 'TREATMENT' })).toEqual({
        ok: false,
        problem: 'PLAN_ITEM_REQUIRED',
      });
      expect(checkDismissal({ ...base, planItemId: 'i-1' })).toEqual({
        ok: false,
        problem: 'PLAN_ITEM_NOT_ALLOWED',
      });
      expect(
        checkDismissal({ ...base, section: 'TREATMENT', planItemId: 'i-1' }),
      ).toEqual({
        ok: true,
        value: {
          ...base,
          section: 'TREATMENT',
          planItemId: 'i-1',
          reasonText: null,
        },
      });
    });
  });
});

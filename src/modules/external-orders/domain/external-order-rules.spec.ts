import { ClinicRole } from '@prisma/client';
import {
  canIssueExternalOrder,
  canSeeClinicalNote,
  canUnlinkResult,
  canVoidExternalOrder,
  checkExternalOrderContent,
  contentErrorMessage,
  externalOrderAgeDays,
  formatExternalOrderNumber,
  isOverdue,
  isValidOverdueDays,
  normalizeVoidReason,
} from './external-order-rules';

const ok = {
  kind: 'IMAGING',
  recipient: '  Centro de Imagen del Este ',
  items: [' Radiografía panorámica ', '', 'Periapical del 36'],
  toothNumbers: ['36', '46'],
  clinicalNote: '  Dolor a la percusión  ',
};

describe('reglas de las órdenes externas (DX-572)', () => {
  describe('contenido', () => {
    it('recorta, quita las líneas vacías y acepta lo válido', () => {
      expect(checkExternalOrderContent(ok)).toEqual({
        ok: true,
        value: {
          kind: 'IMAGING',
          recipient: 'Centro de Imagen del Este',
          items: ['Radiografía panorámica', 'Periapical del 36'],
          toothNumbers: ['36', '46'],
          clinicalNote: 'Dolor a la percusión',
        },
      });
    });

    it('la nota y los dientes son opcionales; una nota vacía es null', () => {
      const check = checkExternalOrderContent({
        ...ok,
        toothNumbers: undefined,
        clinicalNote: '   ',
      });
      expect(check).toMatchObject({
        ok: true,
        value: { toothNumbers: [], clinicalNote: null },
      });
    });

    it('dice TODO lo que falla en un solo 400', () => {
      const check = checkExternalOrderContent({
        kind: 'XRAY',
        recipient: ' ',
        items: [],
        toothNumbers: ['19', '36', '36'],
        clinicalNote: 'x'.repeat(1001),
      });
      expect(check.ok).toBe(false);
      if (check.ok) return;
      expect(check.errors).toHaveLength(5);
      expect(contentErrorMessage(check.errors)).toMatch(
        /^No se puede emitir la orden: el tipo es IMAGING.*FDI.*1000 caracteres\.$/,
      );
    });

    it.each([
      ['destinatario de 121', { recipient: 'x'.repeat(121) }],
      ['21 estudios', { items: Array.from({ length: 21 }, (_, i) => `E${i}`) }],
      ['un estudio de 201', { items: ['x'.repeat(201)] }],
      ['33 dientes', { toothNumbers: Array.from({ length: 33 }, () => '11') }],
      ['un diente que no es FDI', { toothNumbers: ['99'] }],
      ['estudios que no son textos', { items: [1, 2] }],
    ])('rechaza %s', (_name, over) => {
      expect(checkExternalOrderContent({ ...ok, ...over }).ok).toBe(false);
    });

    it('120 caracteres de destinatario, 20 estudios de 200 y 32 dientes valen (cuenta caracteres, no bytes)', () => {
      const teeth = [
        ...['1', '2', '3', '4'].flatMap((q) =>
          ['1', '2', '3', '4', '5', '6', '7', '8'].map((t) => `${q}${t}`),
        ),
      ];
      expect(teeth).toHaveLength(32);
      expect(
        checkExternalOrderContent({
          ...ok,
          recipient: 'ñ'.repeat(120),
          items: Array.from({ length: 20 }, () => 'é'.repeat(200)),
          toothNumbers: teeth,
        }).ok,
      ).toBe(true);
    });
  });

  describe('roles', () => {
    it('emiten DENTIST y ADMIN; la nota la ven los clínicos, nunca recepción', () => {
      expect(
        new Set(Object.values(ClinicRole).filter(canIssueExternalOrder)),
      ).toEqual(new Set([ClinicRole.ADMIN, ClinicRole.DENTIST]));
      expect(canSeeClinicalNote(ClinicRole.ASSISTANT)).toBe(true);
      expect(canSeeClinicalNote(ClinicRole.RECEPTION)).toBe(false);
    });

    it('anula ADMIN, o quien la emitió con un rol que aún emite', () => {
      const order = { issuedById: 'u1' };
      expect(
        canVoidExternalOrder({ userId: 'x', role: ClinicRole.ADMIN }, order),
      ).toBe(true);
      expect(
        canVoidExternalOrder({ userId: 'u1', role: ClinicRole.DENTIST }, order),
      ).toBe(true);
      expect(
        canVoidExternalOrder({ userId: 'u2', role: ClinicRole.DENTIST }, order),
      ).toBe(false);
      expect(
        canVoidExternalOrder(
          { userId: 'u1', role: ClinicRole.ASSISTANT },
          order,
        ),
      ).toBe(false);
    });

    it('desliga un rol clínico o quien ligó el resultado (recepción, solo lo suyo)', () => {
      const order = { resultLinkedById: 'r1' };
      expect(
        canUnlinkResult({ userId: 'x', role: ClinicRole.ASSISTANT }, order),
      ).toBe(true);
      expect(
        canUnlinkResult({ userId: 'r1', role: ClinicRole.RECEPTION }, order),
      ).toBe(true);
      expect(
        canUnlinkResult({ userId: 'r2', role: ClinicRole.RECEPTION }, order),
      ).toBe(false);
    });
  });

  it('motivo de anulación de 5 a 500 caracteres, recortado', () => {
    expect(normalizeVoidReason('  Error de estudio ')).toBe('Error de estudio');
    expect(normalizeVoidReason('Mal')).toBeNull();
    expect(normalizeVoidReason('x'.repeat(501))).toBeNull();
    expect(normalizeVoidReason(42)).toBeNull();
  });

  it('el plazo de la clínica es un entero de 1 a 365', () => {
    expect([0, 1, 15, 365, 366, 1.5, '15'].map(isValidOverdueDays)).toEqual([
      false,
      true,
      true,
      true,
      false,
      false,
      false,
    ]);
  });

  describe('antigüedad en días civiles de la SEDE', () => {
    const tz = 'America/Caracas';

    it('0 el mismo día civil y 1 al siguiente aunque pasen minutos', () => {
      // 23:50 y 00:10 de Caracas (UTC−4): 20 minutos, día siguiente.
      const issued = new Date('2026-11-17T03:50:00Z');
      expect(
        externalOrderAgeDays(issued, new Date('2026-11-17T03:59:00Z'), tz),
      ).toBe(0);
      expect(
        externalOrderAgeDays(issued, new Date('2026-11-17T04:10:00Z'), tz),
      ).toBe(1);
    });

    it('cuenta en la zona de la sede, no en UTC', () => {
      // 2026-11-16 22:00 en Caracas es 2026-11-17 en UTC.
      const issued = new Date('2026-11-17T02:00:00Z');
      const now = new Date('2026-12-01T15:00:00Z');
      expect(externalOrderAgeDays(issued, now, tz)).toBe(15);
      expect(externalOrderAgeDays(issued, now, 'UTC')).toBe(14);
    });

    it('vencida es más de N días, no N', () => {
      expect(isOverdue(15, 15)).toBe(false);
      expect(isOverdue(16, 15)).toBe(true);
    });

    it('nunca negativa (un reloj de la sede por detrás)', () => {
      expect(
        externalOrderAgeDays(
          new Date('2026-11-17T12:00:00Z'),
          new Date('2026-11-16T12:00:00Z'),
          tz,
        ),
      ).toBe(0);
    });
  });

  it('número impreso con 6 cifras', () => {
    expect(formatExternalOrderNumber(42)).toBe('000042');
    expect(formatExternalOrderNumber(1234567)).toBe('1234567');
  });
});

import {
  PAYMENT_INSTRUCTIONS_EMPTY_MESSAGE,
  instructionsFor,
  offeredPaymentMethods,
  parsePaymentInstructions,
} from './payment-method-instructions';

describe('datos para pagar de un medio (DX-569)', () => {
  describe('parsePaymentInstructions', () => {
    it('recorta, y un campo en blanco o ausente es null', () => {
      expect(
        parsePaymentInstructions({
          holderName: '  Clínica Demo  ',
          phone: '   ',
          note: 'Línea 1\nLínea 2',
        }),
      ).toEqual({
        ok: true,
        fields: {
          holderName: 'Clínica Demo',
          holderId: null,
          bankName: null,
          accountNumber: null,
          phone: null,
          email: null,
          note: 'Línea 1\nLínea 2',
        },
      });
    });

    it('al menos un dato con texto', () => {
      expect(parsePaymentInstructions({})).toEqual({
        ok: false,
        message: PAYMENT_INSTRUCTIONS_EMPTY_MESSAGE,
      });
      expect(parsePaymentInstructions({ holderName: ' ', note: null })).toEqual(
        { ok: false, message: PAYMENT_INSTRUCTIONS_EMPTY_MESSAGE },
      );
    });

    it('cada campo con su tope, contado tras recortar', () => {
      expect(
        parsePaymentInstructions({ holderId: ` ${'9'.repeat(30)} ` }).ok,
      ).toBe(true);
      expect(parsePaymentInstructions({ holderId: '9'.repeat(31) })).toEqual({
        ok: false,
        message: 'La identificación del titular admite hasta 30 caracteres.',
      });
      expect(parsePaymentInstructions({ note: 'x'.repeat(281) }).ok).toBe(
        false,
      );
      expect(parsePaymentInstructions({ email: 'a'.repeat(121) }).ok).toBe(
        false,
      );
    });

    it('solo la nota admite saltos de línea; ninguno, caracteres de control', () => {
      expect(parsePaymentInstructions({ bankName: 'A\nB' })).toEqual({
        ok: false,
        message: 'El banco o entidad va en una sola línea.',
      });
      expect(parsePaymentInstructions({ note: 'a\u0007b' }).ok).toBe(false);
    });
  });

  describe('qué datos rigen y qué medios ofrece el enlace en una sede', () => {
    const rows = [
      { paymentMethodId: 'pm', locationId: null, tag: 'clínica' },
      { paymentMethodId: 'pm', locationId: 'sede-a', tag: 'sede A' },
      { paymentMethodId: 'tr', locationId: 'sede-b', tag: 'solo B' },
    ];

    it('la sede gana a la clínica; sin la de la sede, la de la clínica', () => {
      expect(instructionsFor(rows, 'pm', 'sede-a')?.tag).toBe('sede A');
      expect(instructionsFor(rows, 'pm', 'sede-b')?.tag).toBe('clínica');
      expect(instructionsFor(rows, 'tr', 'sede-a')).toBeNull();
    });

    it('activo, permitido en el enlace y con datos para esa sede, por nombre', () => {
      const methods = [
        {
          id: 'tr',
          name: 'Transferencia',
          active: true,
          allowInPaymentLink: true,
        },
        {
          id: 'pm',
          name: 'Pago móvil',
          active: true,
          allowInPaymentLink: true,
        },
        { id: 'ef', name: 'Efectivo', active: true, allowInPaymentLink: false },
        { id: 'zz', name: 'Apagado', active: false, allowInPaymentLink: true },
      ];
      const instructions = [
        ...rows,
        { paymentMethodId: 'ef', locationId: null, tag: 'x' },
        { paymentMethodId: 'zz', locationId: null, tag: 'x' },
      ];
      expect(
        offeredPaymentMethods(methods, instructions, 'sede-a').map(
          (o) => `${o.method.id}:${o.instructions.tag}`,
        ),
      ).toEqual(['pm:sede A']);
      expect(
        offeredPaymentMethods(methods, instructions, 'sede-b').map(
          (o) => `${o.method.id}:${o.instructions.tag}`,
        ),
      ).toEqual(['pm:clínica', 'tr:solo B']);
    });
  });
});

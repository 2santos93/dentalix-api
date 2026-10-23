import {
  AMOUNT_MESSAGE,
  CONTROL_CHARS_MESSAGE,
  DESCRIPTION_MESSAGE,
  DUE_BEFORE_INVOICE_MESSAGE,
  DUE_DATE_INVALID_MESSAGE,
  EXPENSE_VOIDED_EDIT_MESSAGE,
  ExpenseRuleError,
  HAS_PAYMENTS_MESSAGE,
  INVOICE_DATE_FUTURE_MESSAGE,
  INVOICE_DATE_INVALID_MESSAGE,
  PAID_ON_FUTURE_MESSAGE,
  SUPPLIER_MESSAGE,
  VOID_REASON_MESSAGE,
  expenseEditDenial,
  expenseStatus,
  formatMoney,
  paymentCapDenial,
  toCents,
  validateAmount,
  validateCategoryName,
  validateDescription,
  validateDueDate,
  validateInvoiceDate,
  validatePaidOn,
  validateSupplier,
  validateVoidReason,
} from './expense-rules';

const messageOf = (fn: () => unknown): string | null => {
  try {
    fn();
    return null;
  } catch (error) {
    if (error instanceof ExpenseRuleError) return error.message;
    throw error;
  }
};

describe('reglas de un gasto (DX-274)', () => {
  describe('importe', () => {
    it.each([0.01, 150000, 150000.5, 9_999_999_999.99])('acepta %p', (n) => {
      expect(validateAmount(n)).toBe(n);
    });

    it.each([0, -1, 10.005, 1e12, Number.NaN, Infinity, '10', null, undefined])(
      'rechaza %p con el mensaje en español',
      (n) => {
        expect(messageOf(() => validateAmount(n))).toBe(AMOUNT_MESSAGE);
      },
    );

    it('cuenta en céntimos enteros sin arrastrar el error del flotante', () => {
      expect(toCents(0.29)).toBe(29);
      expect(toCents(1.15)).toBe(115);
      expect(toCents(150000.1)).toBe(15000010);
    });

    it('da formato «1.234,50 COP»: miles con punto y coma solo con céntimos', () => {
      expect(formatMoney(15000000, 'COP')).toBe('150.000 COP');
      expect(formatMoney(123450, 'COP')).toBe('1.234,50 COP');
      expect(formatMoney(5, 'USD')).toBe('0,05 USD');
      expect(formatMoney(0, 'USD')).toBe('0 USD');
    });
  });

  describe('textos', () => {
    it('el proveedor se normaliza: recorta, colapsa espacios y vacío es null', () => {
      expect(validateSupplier('  Servicios   Públicos \t S.A. ')).toBe(
        'Servicios Públicos S.A.',
      );
      expect(validateSupplier('   ')).toBeNull();
      expect(validateSupplier(null)).toBeNull();
      expect(validateSupplier(undefined)).toBeNull();
    });

    it('el proveedor admite 200 puntos de código y no 201', () => {
      expect(validateSupplier('x'.repeat(200))).toHaveLength(200);
      expect(messageOf(() => validateSupplier('x'.repeat(201)))).toBe(
        SUPPLIER_MESSAGE,
      );
      // Un emoji cuenta 1, como char_length de Postgres.
      expect(validateSupplier('🦷'.repeat(200))).not.toBeNull();
    });

    it('la descripción admite 500 y rechaza controles, no saltos de línea', () => {
      expect(validateDescription('línea 1\nlínea 2')).toBe('línea 1\nlínea 2');
      expect(messageOf(() => validateDescription('x'.repeat(501)))).toBe(
        DESCRIPTION_MESSAGE,
      );
      expect(messageOf(() => validateDescription('a\u0000b'))).toBe(
        CONTROL_CHARS_MESSAGE,
      );
      expect(validateDescription('  ')).toBeNull();
    });

    it('el nombre de una categoría propia: 2 a 60 tras normalizar', () => {
      expect(validateCategoryName('  Seguros   médicos ')).toBe(
        'Seguros médicos',
      );
      expect(messageOf(() => validateCategoryName('A'))).not.toBeNull();
      expect(
        messageOf(() => validateCategoryName('x'.repeat(61))),
      ).not.toBeNull();
      expect(messageOf(() => validateCategoryName(undefined))).not.toBeNull();
    });

    it('el motivo de anulación: 5 a 500 tras recortar', () => {
      expect(validateVoidReason('  Duplicado  ')).toBe('Duplicado');
      expect(messageOf(() => validateVoidReason('abcd'))).toBe(
        VOID_REASON_MESSAGE,
      );
      expect(messageOf(() => validateVoidReason('    '))).toBe(
        VOID_REASON_MESSAGE,
      );
      expect(messageOf(() => validateVoidReason(undefined))).toBe(
        VOID_REASON_MESSAGE,
      );
      expect(messageOf(() => validateVoidReason('x'.repeat(501)))).toBe(
        VOID_REASON_MESSAGE,
      );
    });
  });

  describe('fechas (día civil de la sede)', () => {
    const today = '2026-10-23';

    it('la factura de hoy o anterior vale; la futura o inexistente, no', () => {
      expect(validateInvoiceDate('2026-10-23', today)).toBe('2026-10-23');
      expect(validateInvoiceDate('2025-01-31', today)).toBe('2025-01-31');
      expect(messageOf(() => validateInvoiceDate('2026-10-24', today))).toBe(
        INVOICE_DATE_FUTURE_MESSAGE,
      );
      expect(messageOf(() => validateInvoiceDate('2026-02-30', today))).toBe(
        INVOICE_DATE_INVALID_MESSAGE,
      );
      expect(messageOf(() => validateInvoiceDate('23/10/2026', today))).toBe(
        INVOICE_DATE_INVALID_MESSAGE,
      );
      expect(messageOf(() => validateInvoiceDate(undefined, today))).toBe(
        INVOICE_DATE_INVALID_MESSAGE,
      );
    });

    it('el vencimiento puede ser el mismo día o posterior, nunca anterior', () => {
      expect(validateDueDate('2026-10-20', '2026-10-20')).toBe('2026-10-20');
      expect(validateDueDate('2026-12-01', '2026-10-20')).toBe('2026-12-01');
      expect(validateDueDate(null, '2026-10-20')).toBeNull();
      expect(validateDueDate(undefined, '2026-10-20')).toBeNull();
      expect(validateDueDate('', '2026-10-20')).toBeNull();
      expect(messageOf(() => validateDueDate('2026-10-19', '2026-10-20'))).toBe(
        DUE_BEFORE_INVOICE_MESSAGE,
      );
      expect(messageOf(() => validateDueDate('mañana', '2026-10-20'))).toBe(
        DUE_DATE_INVALID_MESSAGE,
      );
    });

    it('el pago no puede ser futuro', () => {
      expect(validatePaidOn('2026-10-23', today)).toBe('2026-10-23');
      expect(messageOf(() => validatePaidOn('2026-10-24', today))).toBe(
        PAID_ON_FUTURE_MESSAGE,
      );
    });
  });

  describe('estado derivado (R2)', () => {
    const base = {
      amountCents: 10000,
      paidCents: 0,
      voided: false,
      dueDate: null,
    };
    const today = '2026-10-23';

    it.each([
      [{ paidCents: 0 }, 'PENDING'],
      [{ paidCents: 1 }, 'PARTIAL'],
      [{ paidCents: 9999 }, 'PARTIAL'],
      [{ paidCents: 10000 }, 'PAID'],
      [{ paidCents: 5000, voided: true }, 'VOIDED'],
    ] as const)('%j → %s', (patch, status) => {
      expect(expenseStatus({ ...base, ...patch }, today).status).toBe(status);
    });

    it('vencido: no pagado del todo y con el vencimiento ya pasado', () => {
      const due = (dueDate: string | null, extra = {}) =>
        expenseStatus({ ...base, dueDate, ...extra }, today).overdue;
      expect(due('2026-10-22')).toBe(true);
      expect(due('2026-10-22', { paidCents: 5000 })).toBe(true);
      expect(due('2026-10-23')).toBe(false); // vence hoy: aún no vencido
      expect(due('2026-10-24')).toBe(false);
      expect(due(null)).toBe(false);
      expect(due('2026-10-22', { paidCents: 10000 })).toBe(false);
      expect(due('2026-10-22', { voided: true })).toBe(false);
    });
  });

  describe('tope de pagos (R2)', () => {
    const cap = (liveCents: number, paymentCents: number) =>
      paymentCapDenial({
        amountCents: 15000000,
        liveCents,
        paymentCents,
        currency: 'COP',
      });

    it('admite hasta lo pendiente, justo', () => {
      expect(cap(0, 15000000)).toBeNull();
      expect(cap(10000000, 5000000)).toBeNull();
    });

    it('rechaza un céntimo de más y nombra lo pendiente', () => {
      const denial = cap(10000000, 5000001);
      expect(denial?.kind).toBe('INVALID');
      expect(denial?.message).toBe(
        'El pago supera lo pendiente del gasto (50.000 COP).',
      );
    });

    it('con todo pagado, lo pendiente es 0', () => {
      expect(cap(15000000, 1)?.message).toBe(
        'El pago supera lo pendiente del gasto (0 COP).',
      );
    });
  });

  describe('edición', () => {
    const current = {
      amountCents: 10000,
      locationId: 'loc-1',
      currency: 'COP',
      voided: false,
    };
    const edit = (
      patch: Parameters<typeof expenseEditDenial>[0]['patch'],
      liveCents = 0,
      paymentCount = 0,
      voided = false,
    ) =>
      expenseEditDenial({
        current: { ...current, voided },
        patch,
        liveCents,
        paymentCount,
        currency: 'COP',
      });

    it('un gasto anulado no se edita', () => {
      expect(edit({}, 0, 0, true)?.message).toBe(EXPENSE_VOIDED_EDIT_MESSAGE);
    });

    it('sin pagos se cambia todo', () => {
      expect(
        edit({ amountCents: 1, locationId: 'loc-2', currency: 'USD' }),
      ).toBeNull();
    });

    it('con cualquier pago (aunque esté anulado) no cambia la sede ni la moneda', () => {
      expect(edit({ locationId: 'loc-2' }, 0, 1)?.message).toBe(
        HAS_PAYMENTS_MESSAGE,
      );
      expect(edit({ currency: 'USD' }, 0, 1)?.kind).toBe('CONFLICT');
      // El mismo valor no es un cambio.
      expect(edit({ locationId: 'loc-1', currency: 'COP' }, 0, 1)).toBeNull();
    });

    it('el importe cambia con pagos pero nunca por debajo de lo pagado', () => {
      expect(edit({ amountCents: 6000 }, 6000, 1)).toBeNull();
      expect(edit({ amountCents: 20000 }, 6000, 1)).toBeNull();
      const denial = edit({ amountCents: 5999 }, 6000, 1);
      expect(denial?.kind).toBe('CONFLICT');
      expect(denial?.message).toBe(
        'El importe no puede ser menor a lo ya pagado (60 COP).',
      );
    });

    it('un pago anulado no cuenta como pagado para el importe', () => {
      expect(edit({ amountCents: 1 }, 0, 1)).toBeNull();
    });
  });
});

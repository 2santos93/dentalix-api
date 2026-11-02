import {
  countsTowardPromise,
  evaluatePromise,
  statusAfterVoid,
  type PromisePayment,
} from './payment-promise-rule';

// DX-150 · regla de cumplimiento de un compromiso de pago, con los bordes de
// día en la zona de la sede.
const CARACAS = 'America/Caracas'; // UTC-4 fijo
const MADRID = 'Europe/Madrid'; // UTC+1 en noviembre

const promise = {
  amount: 200_000,
  currency: 'VES',
  dueDate: '2026-11-15',
  createdAt: new Date('2026-11-01T14:00:00.000Z'),
};

function payment(
  paidAt: string,
  amount: number,
  extra: Partial<PromisePayment> = {},
): PromisePayment {
  return {
    amount,
    currency: 'VES',
    paidAt: new Date(paidAt),
    createdAt: new Date(paidAt),
    ...extra,
  };
}

describe('evaluatePromise (DX-150)', () => {
  it('CUMPLIDO con abonos que suman el importe antes de la fecha', () => {
    const result = evaluatePromise(
      promise,
      [
        payment('2026-11-05T14:00:00.000Z', 120_000),
        payment('2026-11-10T14:00:00.000Z', 80_000),
      ],
      { now: new Date('2026-11-10T15:00:00.000Z'), timeZone: CARACAS },
    );
    expect(result).toEqual({ status: 'KEPT', covered: 200_000 });
  });

  it('sigue ABIERTO con abonos parciales mientras no pasa la fecha', () => {
    const result = evaluatePromise(
      promise,
      [payment('2026-11-05T14:00:00.000Z', 150_000)],
      { now: new Date('2026-11-15T22:00:00.000Z'), timeZone: CARACAS },
    );
    expect(result).toEqual({ status: 'OPEN', covered: 150_000 });
  });

  it('el último día cuenta entero en la zona de la sede (23:59 de Caracas = 03:59 UTC del 16)', () => {
    const lastMinute = '2026-11-16T03:59:00.000Z';
    const result = evaluatePromise(promise, [payment(lastMinute, 200_000)], {
      now: new Date('2026-11-16T04:30:00.000Z'),
      timeZone: CARACAS,
    });
    expect(result.status).toBe('KEPT');
  });

  it('INCUMPLIDO desde las 00:00 del 16/11 en la zona de la sede, no antes', () => {
    // 03:59 UTC del 16 = 23:59 del 15 en la zona de la sede: aún abierto.
    expect(
      evaluatePromise(promise, [], {
        now: new Date('2026-11-16T03:59:59.000Z'),
        timeZone: CARACAS,
      }).status,
    ).toBe('OPEN');
    // 04:00 UTC del 16 = 00:00 del 16 en la zona de la sede: incumplido.
    expect(
      evaluatePromise(promise, [], {
        now: new Date('2026-11-16T04:00:00.000Z'),
        timeZone: CARACAS,
      }).status,
    ).toBe('BROKEN');
    // En Madrid el 16 empieza a las 23:00 UTC del 15.
    expect(
      evaluatePromise(promise, [], {
        now: new Date('2026-11-15T23:00:00.000Z'),
        timeZone: MADRID,
      }).status,
    ).toBe('BROKEN');
  });

  it('un abono fechado el 16 en la sede no cubre el compromiso del 15', () => {
    const result = evaluatePromise(
      promise,
      [payment('2026-11-16T04:00:00.000Z', 200_000)],
      { now: new Date('2026-11-16T05:00:00.000Z'), timeZone: CARACAS },
    );
    expect(result).toEqual({ status: 'BROKEN', covered: 0 });
  });

  it('solo cuentan los abonos en la moneda del compromiso', () => {
    const result = evaluatePromise(
      promise,
      [payment('2026-11-05T14:00:00.000Z', 200_000, { currency: 'USD' })],
      { now: new Date('2026-11-05T15:00:00.000Z'), timeZone: CARACAS },
    );
    expect(result).toEqual({ status: 'OPEN', covered: 0 });
  });

  it('no cuentan los abonos registrados antes del compromiso (ni con fecha posterior)', () => {
    const result = evaluatePromise(
      promise,
      [
        payment('2026-11-05T14:00:00.000Z', 200_000, {
          createdAt: new Date('2026-10-30T14:00:00.000Z'),
        }),
      ],
      { now: new Date('2026-11-05T15:00:00.000Z'), timeZone: CARACAS },
    );
    expect(result.status).toBe('OPEN');
  });

  it('cuenta un abono registrado después del compromiso aunque se feche antes', () => {
    const result = evaluatePromise(
      promise,
      [
        payment('2026-10-31T14:00:00.000Z', 200_000, {
          createdAt: new Date('2026-11-02T14:00:00.000Z'),
        }),
      ],
      { now: new Date('2026-11-02T15:00:00.000Z'), timeZone: CARACAS },
    );
    expect(result.status).toBe('KEPT');
  });

  describe('borde de la hora de alta del compromiso (DX-226: las dos horas son de la BD)', () => {
    const at = (ms: number) => new Date(promise.createdAt.getTime() + ms);
    const now = {
      now: new Date('2026-11-05T15:00:00.000Z'),
      timeZone: CARACAS,
    };

    it('un abono dado de alta en el MISMO instante que el compromiso cuenta', () => {
      const result = evaluatePromise(
        promise,
        [payment('2026-11-01T14:00:00.000Z', 200_000, { createdAt: at(0) })],
        now,
      );
      expect(result.status).toBe('KEPT');
    });

    it('un abono dado de alta 1 ms antes del compromiso no cuenta, aunque se feche el mismo día', () => {
      const result = evaluatePromise(
        promise,
        [payment('2026-11-01T14:00:00.000Z', 200_000, { createdAt: at(-1) })],
        now,
      );
      expect(result).toEqual({ status: 'OPEN', covered: 0 });
    });

    it('un abono dado de alta 1 ms después cuenta', () => {
      const result = evaluatePromise(
        promise,
        [payment('2026-11-01T14:00:00.000Z', 200_000, { createdAt: at(1) })],
        now,
      );
      expect(result.status).toBe('KEPT');
    });

    it('el reloj del barrido desfasado ±5 s no cambia qué abonos cuentan', () => {
      const payments = [
        payment('2026-11-01T14:00:00.000Z', 150_000, { createdAt: at(-1) }),
        payment('2026-11-01T14:00:05.000Z', 50_000, { createdAt: at(1) }),
      ];
      for (const skew of [-5_000, 0, 5_000]) {
        expect(
          evaluatePromise(promise, payments, {
            now: new Date(now.now.getTime() + skew),
            timeZone: CARACAS,
          }),
        ).toEqual({ status: 'OPEN', covered: 50_000 });
      }
    });
  });

  it('suma en centavos (0,10 + 0,20 cubre 0,30)', () => {
    const result = evaluatePromise(
      { ...promise, amount: 0.3 },
      [
        payment('2026-11-05T14:00:00.000Z', 0.1),
        payment('2026-11-05T15:00:00.000Z', 0.2),
      ],
      { now: new Date('2026-11-05T16:00:00.000Z'), timeZone: CARACAS },
    );
    expect(result).toEqual({ status: 'KEPT', covered: 0.3 });
  });

  it('cumplido gana a incumplido: el barrido tardío del 16 ve los abonos del 15', () => {
    const result = evaluatePromise(
      promise,
      [payment('2026-11-15T19:00:00.000Z', 200_000)],
      { now: new Date('2026-11-16T11:00:00.000Z'), timeZone: CARACAS },
    );
    expect(result.status).toBe('KEPT');
  });
});

describe('countsTowardPromise (DX-215)', () => {
  it('cuenta un abono de la moneda, registrado desde el compromiso y fechado hasta su día', () => {
    expect(
      countsTowardPromise(
        promise,
        payment('2026-11-15T19:00:00.000Z', 1),
        CARACAS,
      ),
    ).toBe(true);
  });

  it.each([
    [
      'otra moneda',
      payment('2026-11-05T14:00:00.000Z', 1, { currency: 'USD' }),
    ],
    [
      'registrado antes del compromiso',
      payment('2026-11-05T14:00:00.000Z', 1, {
        createdAt: new Date('2026-11-01T13:59:59.000Z'),
      }),
    ],
    ['fechado después de su día', payment('2026-11-16T04:00:00.000Z', 1)],
  ])('no cuenta un abono de %s', (_label, p) => {
    expect(countsTowardPromise(promise, p, CARACAS)).toBe(false);
  });
});

describe('statusAfterVoid (DX-215)', () => {
  const beforeDue = new Date('2026-11-10T15:00:00.000Z');
  const afterDue = new Date('2026-11-16T04:30:00.000Z'); // 00:30 del 16 en la zona de la sede

  it('anular el abono que lo cumplió ANTES de la fecha: vuelve a ABIERTO', () => {
    expect(
      statusAfterVoid(promise, [], {
        now: beforeDue,
        timeZone: CARACAS,
        anotherOpen: false,
      }),
    ).toBe('OPEN');
  });

  it('el último día aún es ABIERTO (23:59 de Caracas)', () => {
    expect(
      statusAfterVoid(promise, [], {
        now: new Date('2026-11-16T03:59:00.000Z'),
        timeZone: CARACAS,
        anotherOpen: false,
      }),
    ).toBe('OPEN');
  });

  it('DESPUÉS de la fecha (zona de la sede): pasa a INCUMPLIDO', () => {
    expect(
      statusAfterVoid(promise, [payment('2026-11-05T14:00:00.000Z', 50_000)], {
        now: afterDue,
        timeZone: CARACAS,
        anotherOpen: false,
      }),
    ).toBe('BROKEN');
  });

  it('el mismo instante en Madrid ya es el 16: INCUMPLIDO', () => {
    expect(
      statusAfterVoid(promise, [], {
        now: new Date('2026-11-15T23:30:00.000Z'),
        timeZone: MADRID,
        anotherOpen: false,
      }),
    ).toBe('BROKEN');
  });

  it('si otro abono vigente sigue cubriendo el importe, sigue CUMPLIDO', () => {
    expect(
      statusAfterVoid(promise, [payment('2026-11-08T14:00:00.000Z', 200_000)], {
        now: afterDue,
        timeZone: CARACAS,
        anotherOpen: false,
      }),
    ).toBe('KEPT');
  });

  it('abonos restantes en otra moneda no lo cubren', () => {
    expect(
      statusAfterVoid(
        promise,
        [payment('2026-11-08T14:00:00.000Z', 200_000, { currency: 'USD' })],
        { now: beforeDue, timeZone: CARACAS, anotherOpen: false },
      ),
    ).toBe('OPEN');
  });

  it('con otro compromiso ya ABIERTO no puede reabrirse (uno abierto por paciente): INCUMPLIDO', () => {
    expect(
      statusAfterVoid(promise, [], {
        now: beforeDue,
        timeZone: CARACAS,
        anotherOpen: true,
      }),
    ).toBe('BROKEN');
  });
});

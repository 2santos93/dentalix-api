import { Prisma } from '@prisma/client';
import { guardHardDeletes, HardDeleteForbiddenError } from './no-hard-delete';

/**
 * Doble mínimo del cliente de transacción: sólo necesita tener la forma
 * `tx.<modelo>.<operación>()` y un `$`-método para comprobar que pasa intacto.
 */
function fakeTx() {
  const calls: string[] = [];
  const model = (name: string) => ({
    findMany: jest.fn(() => {
      calls.push(`${name}.findMany`);
      return Promise.resolve([]);
    }),
    updateMany: jest.fn(() => {
      calls.push(`${name}.updateMany`);
      return Promise.resolve({ count: 1 });
    }),
    delete: jest.fn(() => {
      calls.push(`${name}.delete`);
      return Promise.resolve({});
    }),
    deleteMany: jest.fn(() => {
      calls.push(`${name}.deleteMany`);
      return Promise.resolve({ count: 1 });
    }),
  });
  const tx = {
    patient: model('patient'),
    locationScheduleRange: model('locationScheduleRange'),
    $executeRaw: jest.fn(() => {
      calls.push('$executeRaw');
      return Promise.resolve(1);
    }),
  };
  return { tx, calls };
}

function guard(tx: ReturnType<typeof fakeTx>['tx']) {
  return guardHardDeletes(
    tx as unknown as Prisma.TransactionClient,
  ) as unknown as ReturnType<typeof fakeTx>['tx'];
}

describe('guardHardDeletes', () => {
  it('lanza en delete y no llega a tocar la base de datos', () => {
    const { tx, calls } = fakeTx();
    const guarded = guard(tx);

    expect(() => guarded.patient.delete()).toThrow(HardDeleteForbiddenError);
    // Lo importante no es sólo que lance: es que la llamada real NO ocurra.
    expect(tx.patient.delete).not.toHaveBeenCalled();
    expect(calls).toEqual([]);
  });

  it('lanza en deleteMany', () => {
    const { tx } = fakeTx();
    const guarded = guard(tx);

    expect(() => guarded.locationScheduleRange.deleteMany()).toThrow(
      /Borrado duro prohibido/,
    );
    expect(tx.locationScheduleRange.deleteMany).not.toHaveBeenCalled();
  });

  it('el mensaje dice qué modelo y qué operación se intentó', () => {
    const { tx } = fakeTx();
    const guarded = guard(tx);

    expect(() => guarded.patient.deleteMany()).toThrow(
      /patient\.deleteMany\(\)/,
    );
  });

  it('deja pasar el resto de operaciones sin tocarlas', async () => {
    const { tx, calls } = fakeTx();
    const guarded = guard(tx);

    await guarded.patient.findMany();
    await guarded.locationScheduleRange.updateMany();
    await guarded.$executeRaw();

    expect(calls).toEqual([
      'patient.findMany',
      'locationScheduleRange.updateMany',
      '$executeRaw',
    ]);
  });

  it('devuelve el mismo delegate en accesos repetidos', () => {
    const { tx } = fakeTx();
    const guarded = guard(tx);

    expect(guarded.patient).toBe(guarded.patient);
  });
});

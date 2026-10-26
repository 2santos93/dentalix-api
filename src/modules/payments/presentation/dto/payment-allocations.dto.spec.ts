import { plainToInstance } from 'class-transformer';
import { validate, type ValidationError } from 'class-validator';
import {
  ALLOCATION_INVALID_AMOUNT,
  ALLOCATION_ITEM_NOT_IN_PLAN,
  ALLOCATION_MODE_MISMATCH,
  ALLOCATION_TOO_MANY_LINES,
  ALLOCATION_VERSION_INVALID,
} from '../../domain/allocation-messages';
import { ReplacePaymentAllocationsDto } from './payment-allocations.dto';

const VERSION = 'a'.repeat(64);
const ITEM = '0192f0a0-0000-7000-8000-000000000001';

async function messagesOf(body: object): Promise<string[]> {
  const dto = plainToInstance(ReplacePaymentAllocationsDto, body);
  const errors = await validate(dto, { whitelist: true });
  const flat = (e: ValidationError): string[] => [
    ...Object.values(e.constraints ?? {}),
    ...(e.children ?? []).flatMap(flat),
  ];
  return errors.flatMap(flat);
}

const line = (amount: unknown, treatmentPlanItemId: unknown = ITEM) => ({
  treatmentPlanItemId,
  amount,
});

describe('ReplacePaymentAllocationsDto (DX-051, spec §5.2 y §5.3)', () => {
  it('accepts MANUAL with lines', async () => {
    expect(
      await messagesOf({
        expectedVersion: VERSION,
        mode: 'MANUAL',
        allocations: [line(50.25)],
      }),
    ).toEqual([]);
  });

  it('accepts MANUAL with []', async () => {
    expect(
      await messagesOf({
        expectedVersion: VERSION,
        mode: 'MANUAL',
        allocations: [],
      }),
    ).toEqual([]);
  });

  it('accepts AUTO without allocations', async () => {
    expect(
      await messagesOf({ expectedVersion: VERSION, mode: 'AUTO' }),
    ).toEqual([]);
  });

  it('rejects 3 decimals', async () => {
    expect(
      await messagesOf({
        expectedVersion: VERSION,
        mode: 'MANUAL',
        allocations: [line(10.005)],
      }),
    ).toEqual([ALLOCATION_INVALID_AMOUNT]);
  });

  it('rejects zero, negative and non-numeric amounts', async () => {
    for (const amount of [0, -1, '10', null]) {
      expect(
        await messagesOf({
          expectedVersion: VERSION,
          mode: 'MANUAL',
          allocations: [line(amount)],
        }),
      ).toEqual([ALLOCATION_INVALID_AMOUNT]);
    }
  });

  it('rejects an item id that is not a UUID (on the line: the id registry finds it there)', async () => {
    expect(
      await messagesOf({
        expectedVersion: VERSION,
        mode: 'MANUAL',
        allocations: [line(10, 'no-uuid')],
      }),
    ).toEqual([ALLOCATION_ITEM_NOT_IN_PLAN]);
  });

  it('rejects 201 lines', async () => {
    const allocations = Array.from({ length: 201 }, () => line(1));
    expect(
      await messagesOf({
        expectedVersion: VERSION,
        mode: 'MANUAL',
        allocations,
      }),
    ).toEqual([ALLOCATION_TOO_MANY_LINES]);
  });

  it('accepts 200 lines (duplicates are checked against the plan later)', async () => {
    const allocations = Array.from({ length: 200 }, () => line(1));
    expect(
      await messagesOf({
        expectedVersion: VERSION,
        mode: 'MANUAL',
        allocations,
      }),
    ).toEqual([]);
  });

  it('rejects allocations with AUTO', async () => {
    expect(
      await messagesOf({
        expectedVersion: VERSION,
        mode: 'AUTO',
        allocations: [],
      }),
    ).toEqual([ALLOCATION_MODE_MISMATCH]);
  });

  it('requires allocations with MANUAL', async () => {
    expect(
      await messagesOf({ expectedVersion: VERSION, mode: 'MANUAL' }),
    ).toEqual([ALLOCATION_MODE_MISMATCH]);
  });

  it('rejects a version that is not 64 lowercase hex characters', async () => {
    expect(await messagesOf({ expectedVersion: 'abc', mode: 'AUTO' })).toEqual([
      ALLOCATION_VERSION_INVALID,
    ]);
  });

  it('rejects an unknown mode', async () => {
    const messages = await messagesOf({
      expectedVersion: VERSION,
      mode: 'SOMETIMES',
    });
    expect(messages).toHaveLength(1);
  });

  it('keeps the amount of each line through the whitelist', async () => {
    const dto = plainToInstance(ReplacePaymentAllocationsDto, {
      expectedVersion: VERSION,
      mode: 'MANUAL',
      allocations: [{ ...line(12.5), extra: 'x' }],
    });
    await validate(dto, { whitelist: true });
    expect(dto.allocations).toEqual([
      expect.objectContaining({ treatmentPlanItemId: ITEM, amount: 12.5 }),
    ]);
    expect(dto.allocations?.[0]).not.toHaveProperty('extra');
  });
});

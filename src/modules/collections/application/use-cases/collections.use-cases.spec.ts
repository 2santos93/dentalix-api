import {
  BadRequestException,
  ConflictException,
  NotFoundException,
} from '@nestjs/common';
import { TenantContextService } from '../../../../shared/tenancy/tenant-context.service';
import type { CollectionsRepository } from '../../domain/ports/collections-repository.port';
import type {
  NewCollectionNote,
  NewPaymentPromise,
  PaymentPromiseRow,
} from '../../domain/collections.entity';
import {
  CreateCollectionNoteUseCase,
  CreatePaymentPromiseUseCase,
  MarkBalanceReminderUseCase,
  NOTE_TEXT_TOO_LONG_MESSAGE,
  REMINDER_ALREADY_TODAY_MESSAGE,
  REMINDER_OUTCOME_RESERVED_MESSAGE,
  PROMISE_ALREADY_OPEN_MESSAGE,
  PROMISE_IN_PAST_MESSAGE,
  PROMISE_TOO_FAR_MESSAGE,
} from './collections.use-cases';

const NOW = new Date('2026-11-01T15:00:00.000Z'); // 10:00 del 1/11 en la zona de la sede

function fakeRepo(overrides: Partial<CollectionsRepository> = {}) {
  const notes: NewCollectionNote[] = [];
  const promises: NewPaymentPromise[] = [];
  const repo = {
    patientExists: (id: string) => Promise.resolve(id === 'p1'),
    locationExists: (id: string) => Promise.resolve(id === 'loc-1'),
    defaultLocationFor: () => Promise.resolve('loc-1'),
    timeZoneOf: () => Promise.resolve('America/Caracas'),
    currencyExists: (code: string) => Promise.resolve(code === 'USD'),
    createNote: (input: NewCollectionNote) => {
      notes.push(input);
      return Promise.resolve({
        id: 'n1',
        ...input,
        author: { id: input.authorId, fullName: 'Rita' },
        createdAt: NOW,
      });
    },
    createPromise: (input: NewPaymentPromise) => {
      promises.push(input);
      const row: PaymentPromiseRow = {
        id: 'pp1',
        ...input,
        status: 'OPEN',
        createdBy: { id: input.createdById, fullName: 'Rita' },
        createdAt: NOW,
        settledAt: null,
        reopenedAt: null,
        timeZone: 'America/Caracas',
      };
      return Promise.resolve(row);
    },
    ...overrides,
  } as unknown as CollectionsRepository;
  return { repo, notes, promises };
}

function context(locationId?: string): TenantContextService {
  const ctx = new TenantContextService();
  jest.spyOn(ctx, 'getTenantId').mockReturnValue('t1');
  jest.spyOn(ctx, 'getLocationId').mockReturnValue(locationId);
  return ctx;
}

describe('CreateCollectionNoteUseCase (DX-150)', () => {
  it('guarda la nota recortada con la sede activa y el autor de la sesión', async () => {
    const { repo, notes } = fakeRepo();
    const useCase = new CreateCollectionNoteUseCase(repo, context('loc-1'));
    await useCase.execute(
      'p1',
      { channel: 'CALL', outcome: 'NO_ANSWER', text: '  Volver a llamar  ' },
      'u1',
    );
    expect(notes).toEqual([
      {
        patientId: 'p1',
        locationId: 'loc-1',
        channel: 'CALL',
        outcome: 'NO_ANSWER',
        text: 'Volver a llamar',
        authorId: 'u1',
      },
    ]);
  });

  it('texto de más de 280 caracteres: 400 en español', async () => {
    const { repo } = fakeRepo();
    const useCase = new CreateCollectionNoteUseCase(repo, context());
    await expect(
      useCase.execute(
        'p1',
        { channel: 'CALL', outcome: 'DISPUTE', text: 'x'.repeat(281) },
        'u1',
      ),
    ).rejects.toThrow(new BadRequestException(NOTE_TEXT_TOO_LONG_MESSAGE));
  });

  it('paciente de otra clínica: 404', async () => {
    const { repo } = fakeRepo();
    const useCase = new CreateCollectionNoteUseCase(repo, context());
    await expect(
      useCase.execute(
        'ajeno',
        { channel: 'EMAIL', outcome: 'NO_ANSWER' },
        'u1',
      ),
    ).rejects.toBeInstanceOf(NotFoundException);
  });
});

describe('CreatePaymentPromiseUseCase (DX-150)', () => {
  const input = { amount: 200_000, currency: 'usd', dueDate: '2026-11-15' };

  it('crea el compromiso abierto en la sede de la deuda si no hay sede activa', async () => {
    const { repo, promises } = fakeRepo();
    const useCase = new CreatePaymentPromiseUseCase(repo, context(), () => NOW);
    const out = await useCase.execute('p1', input, 'u1');
    expect(promises[0]).toEqual({
      patientId: 'p1',
      locationId: 'loc-1',
      amount: 200_000,
      currency: 'USD',
      dueDate: '2026-11-15',
      createdById: 'u1',
    });
    expect(out).toMatchObject({ status: 'OPEN', covered: 0 });
    expect(out).not.toHaveProperty('timeZone');
  });

  it('acepta hoy en la zona de la sede y rechaza ayer', async () => {
    const { repo } = fakeRepo();
    const useCase = new CreatePaymentPromiseUseCase(repo, context(), () => NOW);
    await expect(
      useCase.execute('p1', { ...input, dueDate: '2026-11-01' }, 'u1'),
    ).resolves.toBeDefined();
    await expect(
      useCase.execute('p1', { ...input, dueDate: '2026-10-31' }, 'u1'),
    ).rejects.toThrow(PROMISE_IN_PAST_MESSAGE);
  });

  it('más de un año: 400', async () => {
    const { repo } = fakeRepo();
    const useCase = new CreatePaymentPromiseUseCase(repo, context(), () => NOW);
    await expect(
      useCase.execute('p1', { ...input, dueDate: '2027-11-02' }, 'u1'),
    ).rejects.toThrow(PROMISE_TOO_FAR_MESSAGE);
  });

  it('sede de otra clínica o moneda desconocida: 400', async () => {
    const { repo } = fakeRepo();
    const useCase = new CreatePaymentPromiseUseCase(
      repo,
      context('loc-ajena'),
      () => NOW,
    );
    await expect(useCase.execute('p1', input, 'u1')).rejects.toBeInstanceOf(
      BadRequestException,
    );
    const other = new CreatePaymentPromiseUseCase(repo, context(), () => NOW);
    await expect(
      other.execute('p1', { ...input, currency: 'XXX' }, 'u1'),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('ya hay uno abierto: 409 en español', async () => {
    const { repo } = fakeRepo({ createPromise: () => Promise.resolve(null) });
    const useCase = new CreatePaymentPromiseUseCase(repo, context(), () => NOW);
    await expect(useCase.execute('p1', input, 'u1')).rejects.toThrow(
      new ConflictException(PROMISE_ALREADY_OPEN_MESSAGE),
    );
  });
});

describe('DX-146: aviso de saldo («Marcar avisado»)', () => {
  it('la nota genérica no admite REMINDER_SENT (solo entra por su ruta)', async () => {
    const { repo, notes } = fakeRepo();
    const useCase = new CreateCollectionNoteUseCase(repo, context());
    await expect(
      useCase.execute(
        'p1',
        { channel: 'WHATSAPP_LINK', outcome: 'REMINDER_SENT' },
        'u1',
      ),
    ).rejects.toThrow(REMINDER_OUTCOME_RESERVED_MESSAGE);
    expect(notes).toEqual([]);
  });

  it('crea la nota REMINDER_SENT con la sede activa, el canal y el reloj', async () => {
    const calls: { input: NewCollectionNote; now: Date }[] = [];
    const { repo } = fakeRepo({
      createReminderNote: (input: NewCollectionNote, now: Date) => {
        calls.push({ input, now });
        return Promise.resolve({
          id: 'n9',
          ...input,
          author: { id: input.authorId, fullName: 'Rita' },
          createdAt: now,
        });
      },
    });
    const useCase = new MarkBalanceReminderUseCase(
      repo,
      context('loc-1'),
      () => NOW,
    );
    const note = await useCase.execute(
      'p1',
      { channel: 'WHATSAPP_LINK', text: '  ' },
      'u1',
    );
    expect(note.outcome).toBe('REMINDER_SENT');
    expect(calls).toEqual([
      {
        input: {
          patientId: 'p1',
          locationId: 'loc-1',
          channel: 'WHATSAPP_LINK',
          outcome: 'REMINDER_SENT',
          text: null,
          authorId: 'u1',
        },
        now: NOW,
      },
    ]);
  });

  it('409 si ya se avisó hoy; 404 si el paciente no es de la clínica', async () => {
    const { repo } = fakeRepo({
      createReminderNote: () => Promise.resolve(null),
    });
    const useCase = new MarkBalanceReminderUseCase(repo, context(), () => NOW);
    await expect(
      useCase.execute('p1', { channel: 'CALL' }, 'u1'),
    ).rejects.toThrow(new ConflictException(REMINDER_ALREADY_TODAY_MESSAGE));
    await expect(
      useCase.execute('otro', { channel: 'CALL' }, 'u1'),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('400 con una nota de más de 280', async () => {
    const { repo } = fakeRepo();
    const useCase = new MarkBalanceReminderUseCase(repo, context(), () => NOW);
    await expect(
      useCase.execute('p1', { channel: 'CALL', text: 'x'.repeat(281) }, 'u1'),
    ).rejects.toBeInstanceOf(BadRequestException);
  });
});

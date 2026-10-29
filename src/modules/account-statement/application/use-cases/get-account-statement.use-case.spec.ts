import { BadRequestException, NotFoundException } from '@nestjs/common';
import { ClinicRole } from '@prisma/client';
import {
  GetAccountStatementInput,
  GetAccountStatementUseCase,
} from './get-account-statement.use-case';
import { FixedDocumentTypeNamesReader } from '../../../document-type-names/__fixtures__/fixed-document-type-names.reader';
import type { VoidActor } from '../../../payments/domain/void-window';
import {
  AccountStatementData,
  AccountStatementRepository,
} from '../../domain/ports/account-statement-repository.port';
import type { StatementNoticeData } from '../../domain/ports/statement-family-repository.port';

// 2026-03-01 10:00 en Bogotá (UTC-5).
const NOW = new Date('2026-03-01T15:00:00.000Z');
const ADMIN: VoidActor = { userId: 'u-admin', role: ClinicRole.ADMIN };
const RECEPTION: VoidActor = { userId: 'u-recep', role: ClinicRole.RECEPTION };
// Alta de los abonos del fixture: hoy por la mañana en la sede.
const CREATED_TODAY = new Date('2026-03-01T13:00:00.000Z');

function data(): AccountStatementData {
  return {
    clinic: { name: 'Clínica Uno', logoUrl: null },
    patient: {
      id: 'p-1',
      firstName: 'Ana',
      lastName: 'Pérez',
      docType: 'NATIONAL_ID',
      docTypeLabel: null,
      docNumber: '123',
    },
    snapshot: {
      plans: [
        {
          id: 'tp-1',
          status: 'ACCEPTED',
          currency: 'COP',
          createdAt: new Date('2026-01-01'),
          billable: 1000,
        },
      ],
      payments: [
        {
          id: 'pay-1',
          treatmentPlanId: 'tp-1',
          amount: 100,
          currency: 'COP',
          paidAt: new Date('2026-01-10T00:00:00.000Z'),
          method: 'CASH',
          location: { id: 'l-1', name: 'Sede' },
          createdById: 'u-recep',
          createdAt: CREATED_TODAY,
          timeZone: 'America/Bogota',
          voidedAt: null,
          voidedBy: null,
          voidReason: null,
        },
        {
          id: 'pay-2',
          treatmentPlanId: 'tp-1',
          amount: 200,
          currency: 'COP',
          paidAt: new Date('2026-02-10T00:00:00.000Z'),
          method: 'CARD',
          location: { id: 'l-1', name: 'Sede' },
          createdById: 'u-recep',
          createdAt: CREATED_TODAY,
          timeZone: 'America/Bogota',
          voidedAt: null,
          voidedBy: null,
          voidReason: null,
        },
      ],
      paymentPlans: [],
    },
  };
}

function makeUseCase(
  result: AccountStatementData | null = data(),
  notice: StatementNoticeData | null = null,
  names = new FixedDocumentTypeNamesReader(),
) {
  const load = jest.fn<Promise<AccountStatementData | null>, [string]>(() =>
    Promise.resolve(result),
  );
  const repo: AccountStatementRepository = {
    load,
    loadBillablePlans: jest.fn(),
  };
  const uc = new GetAccountStatementUseCase(
    repo,
    () => NOW,
    {
      loadNotice: () => Promise.resolve(notice),
      loadFamily: jest.fn(),
    },
    names,
  );
  return {
    load,
    useCase: {
      execute: (
        patientId: string,
        input: GetAccountStatementInput,
        actor: VoidActor = ADMIN,
      ) => uc.execute(patientId, input, actor),
    },
  };
}

describe('GetAccountStatementUseCase', () => {
  it('404s when the patient is not in this clinic', async () => {
    const { useCase } = makeUseCase(null);
    await expect(useCase.execute('p-x', {})).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  it('returns header data, totals and every movement without a range', async () => {
    const { useCase, load } = makeUseCase();
    const out = await useCase.execute('p-1', {});

    expect(load).toHaveBeenCalledWith('p-1');
    expect(out.issuedAt).toEqual(NOW);
    expect(out.clinic.name).toBe('Clínica Uno');
    expect(out.patient).toMatchObject({ firstName: 'Ana', docNumber: '123' });
    expect(out.range).toEqual({ from: null, to: null });
    expect(out.summary[0]).toMatchObject({ budgeted: 1000, paid: 300 });
    expect(out.movements).toHaveLength(2);
  });

  it('the statement carries the generic type, the label and the display name', async () => {
    const names = new FixedDocumentTypeNamesReader({
      NATIONAL_ID: 'Documento A',
    });
    const local = await makeUseCase(data(), null, names).useCase.execute(
      'p-1',
      {},
    );
    expect(local.patient).toMatchObject({
      docType: 'NATIONAL_ID',
      docTypeLabel: null,
      docTypeName: 'Documento A',
    });

    const labelled = data();
    labelled.patient.docTypeLabel = 'ID local';
    const out = await makeUseCase(labelled, null, names).useCase.execute(
      'p-1',
      {},
    );
    expect(out.patient).toMatchObject({
      docTypeLabel: 'ID local',
      docTypeName: 'ID local',
    });
  });

  it('DX-203: a nombre del paciente adulto con email; el de un menor, a nombre de su responsable', async () => {
    const adult = await makeUseCase(data(), {
      patient: {
        firstName: 'Ana',
        birthDate: new Date('1990-01-01'),
        email: 'ana@example.com',
        emergencyContactName: null,
      },
      responsibles: [],
      settings: { timeZone: 'America/Bogota', majorityAge: 18 },
    }).useCase.execute('p-1', {});
    expect(adult.addressee).toEqual({
      kind: 'PATIENT',
      name: 'Ana Pérez',
      email: 'ana@example.com',
    });

    const minor = await makeUseCase(data(), {
      patient: {
        firstName: 'Ana',
        birthDate: new Date('2016-01-01'),
        email: null,
        emergencyContactName: null,
      },
      responsibles: [
        {
          id: 'r-1',
          name: 'Claudia Navarro',
          email: null,
          isPayer: true,
          receivesNotices: true,
          optedOut: false,
        },
      ],
      settings: { timeZone: 'America/Bogota', majorityAge: 18 },
    }).useCase.execute('p-1', {});
    // Se imprime y se entrega: aunque el responsable no tenga email.
    expect(minor.addressee).toEqual({
      kind: 'RESPONSIBLE',
      name: 'Claudia Navarro',
      email: null,
    });
  });

  it('statement addressee uses the clinic majorityAge', async () => {
    // 17 años el 2026-03-01, con email propio y un responsable con email.
    const out = await makeUseCase(data(), {
      patient: {
        firstName: 'Ana',
        birthDate: new Date('2008-06-01'),
        email: 'ana@example.com',
        emergencyContactName: null,
      },
      responsibles: [
        {
          id: 'r-1',
          name: 'Claudia Navarro',
          email: 'claudia@example.com',
          isPayer: true,
          receivesNotices: true,
          optedOut: false,
        },
      ],
      settings: { timeZone: 'America/Bogota', majorityAge: 16 },
    }).useCase.execute('p-1', {});
    expect(out.addressee).toEqual({
      kind: 'PATIENT',
      name: 'Ana Pérez',
      email: 'ana@example.com',
    });
  });

  it('filters only the movements by an inclusive civil-date range', async () => {
    const { useCase } = makeUseCase();
    const out = await useCase.execute('p-1', {
      from: '2026-02-01',
      to: '2026-02-10',
    });
    expect(out.range).toEqual({ from: '2026-02-01', to: '2026-02-10' });
    expect(out.movements.map((m) => m.id)).toEqual(['pay-2']);
    expect(out.summary[0]).toMatchObject({ paid: 300 });
  });

  it('accepts an open-ended range', async () => {
    const { useCase } = makeUseCase();
    const out = await useCase.execute('p-1', { to: '2026-01-31' });
    expect(out.movements.map((m) => m.id)).toEqual(['pay-1']);
  });

  it.each([
    [{ from: '2026-02-30' }],
    [{ to: '2026-13-01' }],
    [{ from: '2026-03-02', to: '2026-03-01' }],
  ])('rejects an invalid range %j', async (range) => {
    const { useCase, load } = makeUseCase();
    await expect(useCase.execute('p-1', range)).rejects.toBeInstanceOf(
      BadRequestException,
    );
    expect(load).not.toHaveBeenCalled();
  });

  describe('canVoid por movimiento (DX-057)', () => {
    function withPayments(
      ...overrides: Partial<AccountStatementData['snapshot']['payments'][0]>[]
    ): AccountStatementData {
      const base = data();
      const template = base.snapshot.payments[0];
      base.snapshot.payments = overrides.map((o, i) => ({
        ...template,
        id: `pay-${i + 1}`,
        ...o,
      }));
      return base;
    }

    it('recepción: true solo en sus abonos activos registrados hoy en la sede', async () => {
      const { useCase } = makeUseCase(
        withPayments(
          {},
          { createdById: 'u-otra' },
          // 23:30 del 28/02 en Bogotá: ya es 1/03 en UTC, pero no "hoy".
          { createdAt: new Date('2026-03-01T04:30:00.000Z') },
          { createdById: null },
          {
            voidedAt: NOW,
            voidedBy: { id: 'u-admin', fullName: 'Admin' },
            voidReason: 'Duplicado',
          },
        ),
      );

      const out = await useCase.execute('p-1', {}, RECEPTION);

      const byId = new Map(out.movements.map((m) => [m.id, m]));
      expect(byId.get('pay-1')).toMatchObject({
        canVoid: true,
        createdById: 'u-recep',
      });
      expect(byId.get('pay-2')).toMatchObject({
        canVoid: false,
        createdById: 'u-otra',
      });
      expect(byId.get('pay-3')?.canVoid).toBe(false);
      expect(byId.get('pay-4')).toMatchObject({
        canVoid: false,
        createdById: null,
      });
      // Ya anulado: nunca se ofrece anular otra vez.
      expect(byId.get('pay-5')?.canVoid).toBe(false);
    });

    it('ADMIN: true en todo abono activo, false en los ya anulados', async () => {
      const { useCase } = makeUseCase(
        withPayments(
          { createdById: 'u-otra', createdAt: new Date('2025-01-01') },
          { voidedAt: NOW },
        ),
      );

      const out = await useCase.execute('p-1', {}, ADMIN);

      const byId = new Map(out.movements.map((m) => [m.id, m.canVoid]));
      expect(byId.get('pay-1')).toBe(true);
      expect(byId.get('pay-2')).toBe(false);
    });

    it('no expone la zona horaria ni el alta interna del abono', async () => {
      const { useCase } = makeUseCase();
      const out = await useCase.execute('p-1', {}, RECEPTION);
      expect(out.movements[0]).not.toHaveProperty('timeZone');
      expect(out.movements[0]).not.toHaveProperty('createdAt');
    });
  });
});

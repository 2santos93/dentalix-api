import { ForbiddenException, NotFoundException } from '@nestjs/common';
import { ClinicRole } from '@prisma/client';
import type { TenantContextService } from '../../../shared/tenancy/tenant-context.service';
import type { AuditRequestContext } from '../../audit/domain/audit-request-context';
import type {
  CommissionProfessional,
  CommissionReader,
  CommissionRepository,
} from '../domain/ports/commission-repository.port';
import {
  COMMISSION_MESSAGES,
  CommissionUseCases,
} from './commission.use-cases';

// DX-018: quién ve qué, comprobado en el caso de uso (no solo en la web).
const ADMIN = { userId: 'admin', role: ClinicRole.ADMIN };
const DRA_X = { userId: 'dra-x', role: ClinicRole.DENTIST };
const DR_Y = { userId: 'dr-y', role: ClinicRole.DENTIST };

const professional = (userId: string): CommissionProfessional => ({
  userId,
  membershipId: `m-${userId}`,
  name: userId,
  role: ClinicRole.DENTIST,
  active: true,
});

const summary = (userId: string) => ({
  id: `s-${userId}`,
  professional: { ...professional(userId) },
  period: { from: '2026-10-01', to: '2026-10-31' },
  basis: 'COLLECTED' as const,
  releaseMode: 'PER_ITEM' as const,
  percent: 35,
  deductLabCost: false,
  deductCardFee: false,
  closedAt: new Date(),
  closedBy: { userId: 'admin', name: 'Admin' },
  lockDateBefore: null,
  lockDateAfter: '2026-10-31',
  totals: [],
  payment: { status: 'NOTHING_TO_PAY' as const, currencies: [] },
});

function setup(allowed: 'ALL' | string[] = 'ALL') {
  const reader: CommissionReader = {
    rule: jest.fn().mockResolvedValue(null),
    candidates: jest.fn().mockResolvedValue([]),
    planRelease: jest.fn().mockResolvedValue([]),
    settledToAdjust: jest.fn().mockResolvedValue([]),
    lastClosedTo: jest.fn().mockResolvedValue(null),
    overlaps: jest.fn().mockResolvedValue(false),
    patientNames: jest.fn().mockResolvedValue(new Map()),
    zones: jest.fn(),
    today: jest.fn().mockResolvedValue('2026-11-05'),
  };
  const listSettlements = jest.fn().mockResolvedValue([]);
  const repo: jest.Mocked<CommissionRepository> = {
    listProfessionals: jest.fn().mockResolvedValue([]),
    listCategories: jest.fn().mockResolvedValue([]),
    findProfessional: jest.fn((userId: string) =>
      Promise.resolve(userId === 'nadie' ? null : professional(userId)),
    ),
    saveRule: jest.fn(),
    read: jest.fn((fn: (r: CommissionReader) => Promise<unknown>) =>
      fn(reader),
    ) as never,
    close: jest.fn(),
    listSettlements,
    getSettlement: jest.fn((id: string) =>
      Promise.resolve(
        id === 's-dra-x'
          ? { summary: summary('dra-x'), categoryPercents: [], lines: [] }
          : null,
      ),
    ),
  };
  const tenantContext = {
    getAllowedLocationIds: () => allowed,
  } as unknown as TenantContextService;
  const useCases = new CommissionUseCases(
    repo,
    () => new Date(),
    tenantContext,
    {
      payments: jest.fn().mockResolvedValue([]),
      header: jest.fn().mockResolvedValue(null),
    },
  );
  return { useCases, repo, listSettlements };
}

const ctx = {} as AuditRequestContext;
const OCT = { from: '2026-10-01', to: '2026-10-31' };

describe('CommissionUseCases: permisos (DX-018)', () => {
  it('un DENTIST previsualiza lo suyo; lo de otro es 404 sin decir si existe', async () => {
    const { useCases } = setup();
    await expect(useCases.preview(DRA_X, OCT)).resolves.toMatchObject({
      professional: { userId: 'dra-x' },
    });
    await expect(
      useCases.preview(DRA_X, { ...OCT, userId: 'dr-y' }),
    ).rejects.toThrow(NotFoundException);
  });

  it('un DENTIST solo lista sus liquidaciones aunque pida las de otro', async () => {
    const { useCases, listSettlements } = setup();
    await expect(useCases.listSettlements(DRA_X, 'dr-y')).resolves.toEqual([]);
    await useCases.listSettlements(DRA_X, undefined);
    expect(listSettlements).toHaveBeenLastCalledWith({
      userId: 'dra-x',
      limit: 200,
    });
  });

  it('un DENTIST ve su liquidación y no la de otro (404)', async () => {
    const { useCases } = setup();
    await expect(
      useCases.getSettlement(DRA_X, 's-dra-x'),
    ).resolves.toMatchObject({
      id: 's-dra-x',
    });
    await expect(useCases.getSettlement(DR_Y, 's-dra-x')).rejects.toThrow(
      NotFoundException,
    );
  });

  it('el ADMIN con sedes restringidas no ve los honorarios (403)', async () => {
    const { useCases } = setup(['sede-1']);
    await expect(useCases.listRules(ADMIN)).rejects.toThrow(
      new ForbiddenException(COMMISSION_MESSAGES.allLocations),
    );
    await expect(
      useCases.preview(ADMIN, { ...OCT, userId: 'dra-x' }),
    ).rejects.toThrow(ForbiddenException);
  });

  it('profesional de otra clínica o inexistente → 404', async () => {
    const { useCases } = setup();
    await expect(
      useCases.saveRule(
        ADMIN,
        'nadie',
        { basis: 'COLLECTED', releaseMode: 'PER_ITEM', percent: 35 },
        ctx,
      ),
    ).rejects.toThrow(NotFoundException);
  });

  it('sin regla, la vista previa sale vacía y dice por qué no se puede cerrar', async () => {
    const { useCases } = setup();
    await expect(
      useCases.preview(ADMIN, { ...OCT, userId: 'dra-x' }),
    ).resolves.toMatchObject({
      rule: null,
      lines: [],
      totals: [],
      canClose: false,
      blocker: 'NO_RULE',
    });
  });
});

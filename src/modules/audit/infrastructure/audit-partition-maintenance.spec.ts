import { Logger } from '@nestjs/common';
import { AuditPartitionMaintenance } from './audit-partition-maintenance';
import type { PrismaService } from '../../../shared/prisma/prisma.service';

interface Call {
  sql: string;
  values: unknown[];
}

function fakePrisma(result: () => Promise<{ created: number }[]>) {
  const calls: Call[] = [];
  const prisma = {
    $queryRaw: jest.fn(
      (strings: TemplateStringsArray, ...values: unknown[]) => {
        calls.push({ sql: strings.join('?'), values });
        return result();
      },
    ),
  } as unknown as PrismaService;
  return { prisma, calls };
}

describe('AuditPartitionMaintenance (DX-102)', () => {
  afterEach(() => jest.restoreAllMocks());

  it('al arrancar asegura el horizonte configurado con la función de la BD', async () => {
    const { prisma, calls } = fakePrisma(() =>
      Promise.resolve([{ created: 2 }]),
    );
    const log = jest.spyOn(Logger.prototype, 'log').mockImplementation();
    const svc = new AuditPartitionMaintenance(prisma, {
      retentionMonths: 180,
      monthsAhead: 12,
      maintenanceIntervalMs: 0,
    });
    await svc.onApplicationBootstrap();
    expect(calls).toHaveLength(1);
    expect(calls[0].sql).toContain('audit_events_ensure_partitions(?::int)');
    expect(calls[0].values).toEqual([12]);
    expect(log).toHaveBeenCalledWith({
      event: 'audit.partitions_created',
      created: 2,
    });
    svc.onModuleDestroy();
  });

  it('un fallo de la BD no tumba el arranque: queda un warn sin datos de la petición', async () => {
    const { prisma } = fakePrisma(() =>
      Promise.reject(new Error('lock timeout')),
    );
    const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation();
    const svc = new AuditPartitionMaintenance(prisma, {
      retentionMonths: 180,
      monthsAhead: 12,
      maintenanceIntervalMs: 0,
    });
    await expect(svc.onApplicationBootstrap()).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalledWith({
      event: 'audit.partitions_failed',
      error: 'Error',
    });
    svc.onModuleDestroy();
  });

  it('con intervalo programa el reaseguro y lo cancela al apagar', async () => {
    jest.useFakeTimers();
    const { prisma, calls } = fakePrisma(() =>
      Promise.resolve([{ created: 0 }]),
    );
    const svc = new AuditPartitionMaintenance(prisma, {
      retentionMonths: 180,
      monthsAhead: 3,
      maintenanceIntervalMs: 1000,
    });
    await svc.onApplicationBootstrap();
    await jest.advanceTimersByTimeAsync(2500);
    expect(calls).toHaveLength(3);
    svc.onModuleDestroy();
    await jest.advanceTimersByTimeAsync(5000);
    expect(calls).toHaveLength(3);
    jest.useRealTimers();
  });
});

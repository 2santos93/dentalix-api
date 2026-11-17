import { HttpException, NotFoundException } from '@nestjs/common';
import { regionalFormat } from '../../../shared/format/regional-format';
import { TenantContextService } from '../../../shared/tenancy/tenant-context.service';
import type { AuditRequestContext } from '../../audit/domain/audit-request-context';
import type { EmailOutbox } from '../../notifications/email/application/email-outbox.service';
import type {
  DigestAdmin,
  DigestClinic,
  SendRunInput,
  SendRunOutcome,
  WeeklyDigestRepository,
  WeeklyDigestSettings,
} from '../domain/ports/weekly-digest-repository.port';
import { composeWeeklyDigest } from '../domain/weekly-digest';
import type { WeeklyDigestComposer } from './weekly-digest-composer';
import {
  WEEKLY_DIGEST_SEND_JOB,
  WeeklyDigestSender,
  WeeklyDigestSweep,
  weeklyDigestJobKey,
} from './weekly-digest-sender';
import {
  GetWeeklyDigestSettingsUseCase,
  SendWeeklyDigestTestUseCase,
  UpdateWeeklyDigestSettingsUseCase,
  WEEKLY_DIGEST_HOUR_MESSAGE,
  WEEKLY_DIGEST_RECIPIENTS_MESSAGE,
  WEEKLY_DIGEST_WEEKDAY_MESSAGE,
} from './weekly-digest-settings.use-cases';
import {
  ConfirmPublicWeeklyDigestUnsubscribeUseCase,
  GetPublicWeeklyDigestUnsubscribeUseCase,
} from './weekly-digest-unsubscribe.use-cases';

const TENANT = 't-1';
// Lunes 2026-11-16 08:00 en Caracas.
const NOW = new Date('2026-11-16T12:00:00Z');

const CLINIC: DigestClinic = {
  name: 'Sonrisas',
  enabled: true,
  weekday: 1,
  hour: 7,
  principal: {
    id: 'l-1',
    timeZone: 'America/Caracas',
    locale: 'es-VE',
    hourCycle: 'h12',
  },
};

const ADMIN: DigestAdmin = {
  membershipId: 'm-1',
  userId: 'u-1',
  fullName: 'María Pérez',
  email: 'maria@sonrisas.test',
  verified: true,
};

const CTX: AuditRequestContext = {
  tenantId: TENANT,
  locationId: null,
  actor: { userId: 'u-1', role: 'ADMIN' },
  requestId: null,
  ip: null,
  userAgent: null,
};

class FakeRepo implements Partial<WeeklyDigestRepository> {
  clinicValue: DigestClinic | null = { ...CLINIC };
  done = false;
  admins: DigestAdmin[] = [ADMIN];
  eligible: DigestAdmin[] = [ADMIN];
  configured = 1;
  sendRunInputs: SendRunInput[] = [];
  outcome: (input: SendRunInput) => SendRunOutcome = (input) => ({
    kind: 'SENT',
    runId: 'r-1',
    sent: input.deliveries.length,
    skipped: 0,
    deliveryIds: input.deliveries.map((d) => d.id),
  });
  enabled: string[] = [];
  existing = new Set<string>();
  settings: WeeklyDigestSettings = {
    enabled: false,
    weekday: 1,
    hour: 7,
    recipientMembershipIds: [],
  };
  invalid: string[] = [];
  cooldown = 0;
  recorded = 0;

  clinic = () => Promise.resolve(this.clinicValue);
  runDone = () => Promise.resolve(this.done);
  eligibleRecipients = () =>
    Promise.resolve({ eligible: this.eligible, configured: this.configured });
  sendRun = (input: SendRunInput) => {
    this.sendRunInputs.push(input);
    return Promise.resolve(this.outcome(input));
  };
  enabledTenantIds = () => Promise.resolve(this.enabled);
  runExists = (tenantId: string, weekStart: string) =>
    Promise.resolve(this.existing.has(`${tenantId}:${weekStart}`));
  getSettings = () => Promise.resolve(this.settings);
  activeAdmins = () => Promise.resolve(this.admins);
  setSettings = (next: WeeklyDigestSettings) =>
    Promise.resolve(
      this.invalid.length > 0
        ? ({ ok: false, invalidMembershipIds: this.invalid } as const)
        : ({ ok: true, before: this.settings, after: next } as const),
    );
  testCooldownRemaining = () => Promise.resolve(this.cooldown);
  recordTestSend = () => {
    this.recorded += 1;
    return Promise.resolve({ ok: true } as const);
  };
  findUnsubscribeLink = jest.fn(() => Promise.resolve(null));
  clinicName = () => Promise.resolve('Sonrisas');
  unsubscribe = jest.fn(() => Promise.resolve({ removed: true }));
}

function fakeComposer(): WeeklyDigestComposer {
  const digest = composeWeeklyDigest(
    {
      week: { weekStart: '2026-11-09', weekEnd: '2026-11-15' },
      previousWeek: { weekStart: '2026-11-02', weekEnd: '2026-11-08' },
      locations: [],
      total: {
        comparison: { ok: false },
        quotes: { ok: false },
        receivables: { ok: false },
        cash: { ok: false },
      },
    },
    null,
  );
  return {
    compose: jest.fn(() =>
      Promise.resolve({
        digest,
        clinicName: 'Sonrisas',
        fmt: regionalFormat({ locale: 'es-VE', hourCycle: 'h12' }),
        linkBase: 'https://sonrisas.dentalix.app',
      }),
    ),
  } as unknown as WeeklyDigestComposer;
}

function fakeOutbox() {
  const prepared: { input: unknown; kick: jest.Mock }[] = [];
  const outbox = {
    prepareInTx: jest.fn((input: unknown) => {
      const kick = jest.fn();
      prepared.push({ input, kick });
      return Promise.resolve({
        insert: () => Promise.resolve({ id: 'o-1' }),
        kick,
      });
    }),
  };
  return { outbox: outbox as unknown as EmailOutbox, prepared, raw: outbox };
}

describe('WeeklyDigestSender (DX-568, D3/D4)', () => {
  let repo: FakeRepo;
  let mail: ReturnType<typeof fakeOutbox>;
  let sender: WeeklyDigestSender;

  beforeEach(() => {
    repo = new FakeRepo();
    mail = fakeOutbox();
    sender = new WeeklyDigestSender(
      repo as unknown as WeeklyDigestRepository,
      fakeComposer(),
      mail.outbox,
      () => NOW,
    );
  });

  it('un payload que no es un lunes es un error (no envía nada)', async () => {
    await expect(sender.send(TENANT, '2026-11-10')).rejects.toThrow(
      `${WEEKLY_DIGEST_SEND_JOB}: payload inválido`,
    );
    await expect(sender.send(TENANT, 'x')).rejects.toThrow();
    expect(repo.sendRunInputs).toHaveLength(0);
  });

  it('una entrega por destinatario elegible, con su enlace, en una sola transacción', async () => {
    repo.eligible = [
      ADMIN,
      { ...ADMIN, membershipId: 'm-2', email: 'b@x.test' },
    ];
    repo.configured = 3;
    await expect(sender.send(TENANT, '2026-11-09')).resolves.toBe('SENT');
    const [input] = repo.sendRunInputs;
    expect(input.weekStart).toBe('2026-11-09');
    expect(input.configuredRecipients).toBe(3);
    expect(input.deliveries.map((d) => d.membershipId)).toEqual(['m-1', 'm-2']);
    for (const d of input.deliveries) {
      expect(d.tokenHash).toMatch(/^[0-9a-f]{64}$/);
      // 60 días de vida.
      expect(d.expiresAt.getTime() - NOW.getTime()).toBe(60 * 86_400_000);
    }
    const [first] = mail.prepared;
    expect(first.input).toMatchObject({
      tenantId: TENANT,
      to: 'maria@sonrisas.test',
      template: 'weekly-digest',
      referenceId: input.deliveries[0].id,
      enforceQuota: false,
    });
    const vars = (first.input as { vars: { unsubscribeUrl: string } }).vars;
    expect(vars.unsubscribeUrl).toMatch(
      /^https:\/\/sonrisas\.dentalix\.app\/resumen\/baja\/[A-Za-z0-9_-]{43}$/,
    );
    // El despachador solo se despierta tras el COMMIT y por lo encolado.
    expect(mail.prepared.every((p) => p.kick.mock.calls.length === 1)).toBe(
      true,
    );
  });

  it('solo despierta al despachador por las entregas que de verdad se guardaron', async () => {
    repo.eligible = [ADMIN, { ...ADMIN, membershipId: 'm-2' }];
    repo.outcome = (input) => ({
      kind: 'SENT',
      runId: 'r',
      sent: 1,
      skipped: 1,
      deliveryIds: [input.deliveries[1].id],
    });
    await sender.send(TENANT, '2026-11-09');
    expect(mail.prepared.map((p) => p.kick.mock.calls.length)).toEqual([0, 1]);
  });

  it('desactivado, ya enviado o de una semana que ya no es la anterior: no envía', async () => {
    repo.done = true;
    await expect(sender.send(TENANT, '2026-11-09')).resolves.toBe(
      'ALREADY_DONE',
    );
    // El trabajo se quedó esperando: hoy la semana anterior es la del 9.
    await expect(sender.send(TENANT, '2026-11-02')).resolves.toBe('STALE');
    repo.clinicValue = { ...CLINIC, enabled: false };
    await expect(sender.send(TENANT, '2026-11-09')).resolves.toBe('DISABLED');
    repo.clinicValue = null;
    await expect(sender.send(TENANT, '2026-11-09')).resolves.toBe(
      'NO_LOCATION',
    );
    expect(repo.sendRunInputs).toHaveLength(0);
  });

  it('con la reserva perdida no llega a encolar nada', async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(
      sender.send(TENANT, '2026-11-09', controller.signal),
    ).rejects.toThrow('Intento abortado');
    expect(repo.sendRunInputs).toHaveLength(0);
  });

  it('sin destinatarios elegibles el envío queda SKIPPED (lo decide el repositorio)', async () => {
    repo.eligible = [];
    repo.outcome = () => ({ kind: 'SKIPPED', runId: 'r', skipped: 1 });
    await expect(sender.send(TENANT, '2026-11-09')).resolves.toBe('SKIPPED');
    expect(repo.sendRunInputs[0].deliveries).toEqual([]);
  });
});

describe('WeeklyDigestSweep (DX-568, D3)', () => {
  it('encola por clínica la semana que toca con su clave; salta las enviadas, las que no tocan y sigue tras un fallo', async () => {
    const repo = new FakeRepo();
    repo.enabled = ['t-a', 't-b', 't-c', 't-d'];
    repo.existing.add('t-b:2026-11-09');
    const clinics: Record<string, DigestClinic | Error> = {
      't-a': CLINIC,
      't-b': CLINIC,
      // Martes 9:00: aún no toca.
      't-c': { ...CLINIC, weekday: 2, hour: 9 },
      't-d': new Error('BD caída'),
    };
    const tenantContext = new TenantContextService();
    repo.clinic = () => {
      const value = clinics[tenantContext.getTenantId()!];
      return value instanceof Error
        ? Promise.reject(value)
        : Promise.resolve(value);
    };
    const enqueued: unknown[] = [];
    const sweep = new WeeklyDigestSweep(
      repo as unknown as WeeklyDigestRepository,
      {
        enqueue: (name, payload, options) => {
          enqueued.push({ name, payload, options });
          return Promise.resolve({ id: 'j', created: true });
        },
      },
      () => NOW,
      tenantContext,
    );
    await expect(sweep.run()).rejects.toThrow(
      'Barrido del resumen semanal falló en 1 clínica(s)',
    );
    expect(enqueued).toEqual([
      {
        name: WEEKLY_DIGEST_SEND_JOB,
        payload: { weekStart: '2026-11-09' },
        options: {
          tenantId: 't-a',
          idempotencyKey: weeklyDigestJobKey('t-a', '2026-11-09'),
        },
      },
    ]);
    expect(weeklyDigestJobKey('t-a', '2026-11-09')).toBe(
      'weekly-digest:t-a:2026-11-09',
    );
  });
});

describe('Ajustes del resumen (DX-568, D1)', () => {
  let repo: FakeRepo;
  let get: GetWeeklyDigestSettingsUseCase;
  let update: UpdateWeeklyDigestSettingsUseCase;

  beforeEach(() => {
    repo = new FakeRepo();
    get = new GetWeeklyDigestSettingsUseCase(
      repo as unknown as WeeklyDigestRepository,
    );
    update = new UpdateWeeklyDigestSettingsUseCase(
      repo as unknown as WeeklyDigestRepository,
      get,
    );
  });

  it('candidatos con el correo enmascarado y aviso si está activado sin destinatarios', async () => {
    repo.settings = { ...repo.settings, enabled: true };
    await expect(get.execute()).resolves.toEqual({
      enabled: true,
      weekday: 1,
      hour: 7,
      recipientMembershipIds: [],
      candidates: [
        {
          membershipId: 'm-1',
          name: 'María Pérez',
          email: 'ma***@sonrisas.test',
          verified: true,
        },
      ],
      warnings: ['NO_RECIPIENTS'],
    });
  });

  it('día, hora y destinatarios inválidos: 400 en español', async () => {
    const base = {
      enabled: true,
      weekday: 1,
      hour: 7,
      recipientMembershipIds: ['m-1'],
    };
    await expect(update.execute({ ...base, weekday: 7 }, CTX)).rejects.toThrow(
      WEEKLY_DIGEST_WEEKDAY_MESSAGE,
    );
    await expect(update.execute({ ...base, hour: 24 }, CTX)).rejects.toThrow(
      WEEKLY_DIGEST_HOUR_MESSAGE,
    );
    repo.invalid = ['m-x'];
    await expect(update.execute(base, CTX)).rejects.toThrow(
      WEEKLY_DIGEST_RECIPIENTS_MESSAGE,
    );
    repo.invalid = [];
    await expect(update.execute(base, CTX)).resolves.toMatchObject({
      recipientMembershipIds: ['m-1'],
      warnings: [],
    });
  });
});

describe('Enviarme una prueba (DX-568, D1)', () => {
  let repo: FakeRepo;
  let mail: ReturnType<typeof fakeOutbox>;
  let useCase: SendWeeklyDigestTestUseCase;

  beforeEach(() => {
    repo = new FakeRepo();
    mail = fakeOutbox();
    useCase = new SendWeeklyDigestTestUseCase(
      repo as unknown as WeeklyDigestRepository,
      fakeComposer(),
      mail.outbox,
      () => NOW,
    );
  });

  it('a quien la pide, con «[Prueba]» y sin baja, y auditada en la transacción', async () => {
    await expect(useCase.execute(CTX)).resolves.toEqual({
      sentTo: 'ma***@sonrisas.test',
      weekStart: '2026-11-09',
      weekEnd: '2026-11-15',
    });
    const [p] = mail.prepared;
    expect(p.input).toMatchObject({
      to: 'maria@sonrisas.test',
      template: 'weekly-digest',
      enforceQuota: true,
      vars: { isTest: true, unsubscribeUrl: null },
    });
    expect((p.input as { referenceId?: string }).referenceId).toBeUndefined();
    expect(repo.recorded).toBe(1);
    expect(p.kick).toHaveBeenCalledTimes(1);
  });

  it('correo sin confirmar: 409; otra prueba antes de 5 min: 429 con la espera', async () => {
    repo.admins = [{ ...ADMIN, verified: false }];
    await expect(useCase.execute(CTX)).rejects.toMatchObject({
      status: 409,
      response: { code: 'EMAIL_NOT_VERIFIED' },
    });
    repo.admins = [ADMIN];
    repo.cooldown = 200;
    const error = await useCase.execute(CTX).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(HttpException);
    expect((error as HttpException).getStatus()).toBe(429);
    expect((error as HttpException).getResponse()).toMatchObject({
      retryAfterSeconds: 200,
      message:
        'Ya te enviamos una prueba hace un momento. Espera 4 minutos para pedir otra.',
    });
    expect(mail.prepared).toHaveLength(0);
  });
});

describe('Baja pública (DX-568, D7)', () => {
  it('sin clínica en el host o con un token imposible: 404 sin consultar', async () => {
    const repo = new FakeRepo();
    const tenantContext = new TenantContextService();
    const get = new GetPublicWeeklyDigestUnsubscribeUseCase(
      tenantContext,
      repo as unknown as WeeklyDigestRepository,
      () => NOW,
    );
    const confirm = new ConfirmPublicWeeklyDigestUnsubscribeUseCase(
      tenantContext,
      repo as unknown as WeeklyDigestRepository,
      () => NOW,
    );
    await expect(get.execute('A'.repeat(43))).rejects.toBeInstanceOf(
      NotFoundException,
    );
    await tenantContext.run(TENANT, async () => {
      await expect(get.execute('corto')).rejects.toBeInstanceOf(
        NotFoundException,
      );
      await expect(
        confirm.execute('A'.repeat(43), {
          requestId: null,
          ip: null,
          userAgent: null,
        }),
      ).rejects.toBeInstanceOf(NotFoundException);
    });
    expect(repo.findUnsubscribeLink).toHaveBeenCalledTimes(1);
    expect(repo.unsubscribe).not.toHaveBeenCalled();
  });
});

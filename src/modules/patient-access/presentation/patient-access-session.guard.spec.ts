import type { ExecutionContext, HttpException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { TenantContextService } from '../../../shared/tenancy/tenant-context.service';
import {
  PATIENT_ACCESS_COOKIE,
  derivePatientAccessSessionKey,
  signPatientAccessSession,
} from '../domain/patient-access-session';
import type {
  PatientAccessRepository,
  SessionLink,
} from '../domain/ports/patient-access-repository.port';
import {
  PatientAccessSessionGuard,
  type PatientAccessRequest,
} from './patient-access-session.guard';

const KEY = derivePatientAccessSessionKey('secreto-de-prueba-0123456789abcdef');
const TENANT = '11111111-1111-4111-8111-111111111111';
const OTHER = '22222222-2222-4222-8222-222222222222';
const LINK = '33333333-3333-4333-8333-333333333333';
const NOW = new Date('2026-11-18T15:00:00.000Z');

function live(overrides: Partial<SessionLink> = {}): SessionLink {
  return {
    id: LINK,
    patientId: 'p1',
    scopes: ['ACCOUNT'],
    expiresAt: new Date(NOW.getTime() + 86_400_000),
    revokedAt: null,
    patientArchived: false,
    ...overrides,
  };
}

function run(opts: {
  cookie?: string;
  authorization?: string;
  hostTenant?: string | null;
  link?: SessionLink | null;
}) {
  const tenantContext = new TenantContextService();
  const seenTenant: (string | undefined)[] = [];
  const repo = {
    findSessionLink: jest.fn(() => {
      seenTenant.push(tenantContext.getTenantId());
      return Promise.resolve(opts.link === undefined ? live() : opts.link);
    }),
  };
  const guard = new PatientAccessSessionGuard(
    tenantContext,
    repo as unknown as PatientAccessRepository,
    KEY,
    () => NOW,
    new ConfigService({ NODE_ENV: 'test' }),
  );
  const headers: Record<string, string> = {};
  const cleared: string[] = [];
  const req: PatientAccessRequest = {
    headers: {
      ...(opts.cookie ? { cookie: opts.cookie } : {}),
      ...(opts.authorization ? { authorization: opts.authorization } : {}),
    },
    tenantHost: {
      host: 'sonrisa.dentalix.app',
      tenantId: opts.hostTenant === undefined ? TENANT : opts.hostTenant,
    },
  };
  const res = {
    setHeader: (k: string, v: string) => {
      headers[k] = v;
    },
    clearCookie: (name: string) => cleared.push(name),
  };
  const ctx = {
    switchToHttp: () => ({ getRequest: () => req, getResponse: () => res }),
  } as unknown as ExecutionContext;
  const outcome = guard.canActivate(ctx).then(
    (ok) => ({ ok, status: 200 }),
    (e: HttpException) => ({ ok: false, status: e.getStatus() }),
  );
  return { outcome, req, headers, cleared, repo, seenTenant };
}

const cookieFor = (tenant = TENANT, exp = new Date(NOW.getTime() + 60_000)) =>
  `${PATIENT_ACCESS_COOKIE}=${signPatientAccessSession(KEY, tenant, LINK, exp)}`;

describe('PatientAccessSessionGuard (DX-101)', () => {
  it('con la cookie válida deja solo enlace, paciente y apartados, releyendo bajo el tenant del host', async () => {
    const { outcome, req, seenTenant } = run({ cookie: cookieFor() });
    await expect(outcome).resolves.toEqual({ ok: true, status: 200 });
    expect(req.patientAccess).toEqual({
      linkId: LINK,
      patientId: 'p1',
      scopes: ['ACCOUNT'],
      sessionExpiresAt: new Date(NOW.getTime() + 60_000),
    });
    expect(seenTenant).toEqual([TENANT]);
  });

  it('fija no-store, no-referrer y noindex también en los errores', async () => {
    const { outcome, headers } = run({});
    await expect(outcome).resolves.toEqual({ ok: false, status: 401 });
    expect(headers).toEqual({
      'Cache-Control': 'no-store',
      Pragma: 'no-cache',
      'Referrer-Policy': 'no-referrer',
      'X-Robots-Tag': 'noindex, nofollow',
    });
  });

  it('el Bearer del personal no abre el portal (401)', async () => {
    const { outcome, repo } = run({ authorization: 'Bearer eyJ.staff.jwt' });
    await expect(outcome).resolves.toEqual({ ok: false, status: 401 });
    expect(repo.findSessionLink).not.toHaveBeenCalled();
  });

  it('una cookie de otra clínica (host manipulado), caducada o sin clínica en el host: 401 sin tocar la base', async () => {
    for (const opts of [
      { cookie: cookieFor(OTHER) },
      { cookie: cookieFor(TENANT, new Date(NOW.getTime() - 1)) },
      { cookie: cookieFor(), hostTenant: null },
    ]) {
      const { outcome, repo } = run(opts);
      await expect(outcome).resolves.toEqual({ ok: false, status: 401 });
      expect(repo.findSessionLink).not.toHaveBeenCalled();
    }
  });

  it('revocado, caducado o con el paciente archivado: 410 y borra la cookie', async () => {
    for (const link of [
      live({ revokedAt: NOW }),
      live({ expiresAt: NOW }),
      live({ patientArchived: true }),
    ]) {
      const { outcome, cleared } = run({ cookie: cookieFor(), link });
      await expect(outcome).resolves.toEqual({ ok: false, status: 410 });
      expect(cleared).toEqual([PATIENT_ACCESS_COOKIE]);
    }
  });

  it('firmada pero sin fila visible: 401', async () => {
    const { outcome } = run({ cookie: cookieFor(), link: null });
    await expect(outcome).resolves.toEqual({ ok: false, status: 401 });
  });
});

import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { App } from 'supertest/types';
import { Prisma, PrismaClient } from '@prisma/client';
import { AppModule } from '../src/app.module';
import { DNS_RESOLVER } from '../src/modules/domains/domain/ports/dns-resolver.port';
import { DomainClock } from '../src/modules/domains/application/domain-clock';
import { DomainRecheckSweep } from '../src/modules/domains/application/domain-recheck';
import { JobWorker } from '../src/modules/jobs/application/job-worker.service';
import {
  FakeClock,
  FakeDns,
} from '../src/modules/domains/application/__fixtures__/fake-domains';
import { hostFor } from './support/tenant-host';
import { registerVerified } from './support/register-verified';
import { resetDatabase } from './support/e2e-fixtures';
import {
  REGIONAL_BOGOTA_FIXTURE,
  registerBody,
} from './support/location-fixtures';

const raw = new PrismaClient<Prisma.PrismaClientOptions>({
  datasources: { db: { url: process.env.DIRECT_URL } },
});

interface LoginResponseBody {
  accessToken: string;
}
interface DomainBody {
  id: string;
  host: string;
  status: string;
  verifyToken: string;
  expiresAt: string | null;
  failedChecks: number;
}
interface RegisterDomainBody {
  domain: DomainBody;
  dns: { name: string; type: string; value: string };
}

const SUB = 'clinica-domains';
const SUB_B = 'clinica-domains-b';
const CUSTOM = 'citas.clinica-domains-white.com';
const SQUAT = 'citas.clinica-domains-squat.com';
const HOUR = 3_600_000;
const txt = (host: string) => `_dentalix-verify.${host}`;

describe('Domains (e2e)', () => {
  let app: INestApplication<App>;
  let token: string;
  let tokenB: string;
  const dns = new FakeDns();
  const clock = new FakeClock();

  const as = (sub: string, bearer: string) => ({
    post: (path: string) =>
      request(app.getHttpServer())
        .post(`/api/v1${path}`)
        .set('X-Tenant-Host', hostFor(sub))
        .set('Authorization', `Bearer ${bearer}`),
    get: (path: string) =>
      request(app.getHttpServer())
        .get(`/api/v1${path}`)
        .set('X-Tenant-Host', hostFor(sub))
        .set('Authorization', `Bearer ${bearer}`),
    delete: (path: string) =>
      request(app.getHttpServer())
        .delete(`/api/v1${path}`)
        .set('X-Tenant-Host', hostFor(sub))
        .set('Authorization', `Bearer ${bearer}`),
  });
  const A = () => as(SUB, token);
  const B = () => as(SUB_B, tokenB);

  /** ¿A qué clínica enruta `host`? Un token de A solo vale en A. */
  const routesToA = async (host: string): Promise<boolean> => {
    const res = await request(app.getHttpServer())
      .get('/api/v1/staff')
      .set('X-Tenant-Host', host)
      .set('Authorization', `Bearer ${token}`);
    return res.status === 200;
  };

  async function listOf(clinic: () => ReturnType<typeof as>) {
    const res = await clinic().get('/domains').expect(200);
    return res.body as DomainBody[];
  }

  async function signUp(sub: string, fullName: string): Promise<string> {
    await registerVerified(
      app,
      registerBody(REGIONAL_BOGOTA_FIXTURE, {
        clinicName: `Clinica ${sub}`,
        subdomain: sub,
        email: `owner@${sub}.com`,
        password: 'S3cret!!',
        fullName,
      }),
    );
    const login = await request(app.getHttpServer())
      .post('/api/v1/auth/login')
      .set('X-Tenant-Host', hostFor(sub))
      .send({ email: `owner@${sub}.com`, password: 'S3cret!!' })
      .expect(201);
    return (login.body as LoginResponseBody).accessToken;
  }

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [AppModule],
    })
      .overrideProvider(DNS_RESOLVER)
      .useValue(dns)
      .overrideProvider(DomainClock)
      .useValue(clock)
      .compile();
    app = moduleRef.createNestApplication();
    app.setGlobalPrefix('api/v1');
    app.useGlobalPipes(
      new ValidationPipe({ whitelist: true, transform: true }),
    );
    await app.init();
    await resetDatabase(raw);

    token = await signUp(SUB, 'Dr. Owner');
    tokenB = await signUp(SUB_B, 'Dra. Real');
  });

  afterAll(async () => {
    await raw.job.deleteMany({ where: { name: { startsWith: 'domains.' } } });
    await resetDatabase(raw);
    await app.close();
    await raw.$disconnect();
  });

  it('registers a custom domain as PENDING with DNS instructions and a 72 h expiry', async () => {
    const res = await A().post('/domains').send({ host: CUSTOM }).expect(201);
    const body = res.body as RegisterDomainBody;
    expect(body.domain.status).toBe('PENDING');
    expect(new Date(body.domain.expiresAt!).getTime()).toBe(
      clock.now().getTime() + 72 * HOUR,
    );
    expect(body.dns).toEqual({
      name: txt(CUSTOM),
      type: 'TXT',
      value: body.domain.verifyToken,
    });
  });

  it('does NOT resolve a pending custom domain', async () => {
    // Token is valid, but the pending host resolves to no tenant -> 401.
    expect(await routesToA(CUSTOM)).toBe(false);
  });

  it('verifies the TXT through POST /domains/:id/verify and then resolves it', async () => {
    const [domain] = await listOf(A);
    await A().post('/domains/not-a-uuid/verify').expect(400);
    await A()
      .post(`/domains/${domain.id}/verify`)
      .expect(201)
      .expect({ status: 'PENDING' });
    dns.records.set(txt(CUSTOM), [domain.verifyToken]);
    await A()
      .post(`/domains/${domain.id}/verify`)
      .expect(201)
      .expect({ status: 'VERIFIED' });
    expect(await routesToA(CUSTOM)).toBe(true);
  });

  it('lists the tenant’s domains', async () => {
    const list = await listOf(A);
    expect(list.map((d) => [d.host, d.status])).toEqual([[CUSTOM, 'VERIFIED']]);
  });

  describe('SEC-009: PENDING no bloquea (squatting)', () => {
    let squat: RegisterDomainBody;

    it('A registers a host that is not its own: it stays PENDING and routes nowhere', async () => {
      const res = await A().post('/domains').send({ host: SQUAT }).expect(201);
      squat = res.body as RegisterDomainBody;
      expect(squat.domain.status).toBe('PENDING');
    });

    it('B (the real owner) can also register it in PENDING — before SEC-009 this was 409', async () => {
      const res = await B().post('/domains').send({ host: SQUAT }).expect(201);
      const real = res.body as RegisterDomainBody;
      expect(real.domain.status).toBe('PENDING');
      expect(real.domain.verifyToken).not.toBe(squat.domain.verifyToken);
    });

    it('the first to verify the TXT (B) wins; A’s PENDING is invalidated (EXPIRED, 410 on verify)', async () => {
      const [real] = await listOf(B);
      dns.records.set(txt(SQUAT), [real.verifyToken]);
      await B()
        .post(`/domains/${real.id}/verify`)
        .expect(201)
        .expect({ status: 'VERIFIED' });

      const mine = (await listOf(A)).find((d) => d.host === SQUAT);
      expect(mine?.status).toBe('EXPIRED');
      dns.records.set(txt(SQUAT), [real.verifyToken, squat.domain.verifyToken]);
      await A().post(`/domains/${squat.domain.id}/verify`).expect(410);
      // Ni puede volver a registrarlo mientras B lo tenga verificado.
      await A().post('/domains').send({ host: SQUAT }).expect(409);
      expect(await routesToA(SQUAT)).toBe(false);
    });

    it('a PENDING older than 72 h is EXPIRED, blocks nobody and can be registered again', async () => {
      const host = 'citas.clinica-domains-old.com';
      const first = (await A().post('/domains').send({ host }).expect(201))
        .body as RegisterDomainBody;
      clock.advance(72 * HOUR);
      expect((await listOf(A)).find((d) => d.host === host)?.status).toBe(
        'EXPIRED',
      );
      await A().post(`/domains/${first.domain.id}/verify`).expect(410);
      await B().post('/domains').send({ host }).expect(201);
      const again = (await A().post('/domains').send({ host }).expect(201))
        .body as RegisterDomainBody;
      expect(again.domain.id).not.toBe(first.domain.id);
      expect(again.domain.status).toBe('PENDING');
    });
  });

  describe('SEC-009: DELETE /domains/:id', () => {
    it('400 for a non-UUID id', async () => {
      await A().delete('/domains/not-a-uuid').expect(400);
    });

    it('404 for a domain of another tenant (and it is left untouched)', async () => {
      const [ofB] = await listOf(B);
      await A().delete(`/domains/${ofB.id}`).expect(404);
      expect((await listOf(B)).map((d) => d.id)).toContain(ofB.id);
    });

    it('soft-deletes its own domain (any state), audits it and stops routing at once', async () => {
      const expired = (await listOf(A)).find((d) => d.status === 'EXPIRED');
      await A().delete(`/domains/${expired!.id}`).expect(204);
      await A().delete(`/domains/${expired!.id}`).expect(404);

      const verified = (await listOf(A)).find((d) => d.host === CUSTOM);
      expect(await routesToA(CUSTOM)).toBe(true);
      await A().delete(`/domains/${verified!.id}`).expect(204);
      expect(await routesToA(CUSTOM)).toBe(false);
      expect((await listOf(A)).map((d) => d.id)).not.toContain(verified!.id);
      const row = await raw.tenantDomain.findUniqueOrThrow({
        where: { id: verified!.id },
      });
      expect(row.deletedAt).not.toBeNull();

      const events = await raw.auditEvent.findMany({
        where: { resourceType: 'TENANT_DOMAIN', resourceId: verified!.id },
        select: { action: true, actorRole: true },
      });
      expect(events).toEqual(
        expect.arrayContaining([{ action: 'DELETE', actorRole: 'ADMIN' }]),
      );
    });

    it('a deleted host can be registered and verified again', async () => {
      const res = await A().post('/domains').send({ host: CUSTOM }).expect(201);
      const body = res.body as RegisterDomainBody;
      dns.records.set(txt(CUSTOM), [body.domain.verifyToken]);
      await A()
        .post(`/domains/${body.domain.id}/verify`)
        .expect(201)
        .expect({ status: 'VERIFIED' });
      expect(await routesToA(CUSTOM)).toBe(true);
    });

    // Los roles que no son ADMIN (403) los cubre role-matrix.e2e-spec.ts.
    it('without a session: 401', async () => {
      const [domain] = await listOf(A);
      const res = await request(app.getHttpServer())
        .delete(`/api/v1/domains/${domain.id}`)
        .set('X-Tenant-Host', hostFor(SUB));
      expect(res.status).toBe(401);
    });
  });

  describe('SEC-009: re-verificación periódica (cola de DX-085)', () => {
    async function recheckRound(): Promise<void> {
      await app.get(DomainRecheckSweep).run();
      await app.get(JobWorker).drain();
      clock.advance(HOUR);
    }

    it('keeps a domain whose TXT is still there; disables it (stops routing) after 3 consecutive misses', async () => {
      await recheckRound();
      const before = (await listOf(A)).find((d) => d.host === CUSTOM);
      expect(before).toMatchObject({ status: 'VERIFIED', failedChecks: 0 });

      // El dominio caduca y lo compra un tercero: su TXT desaparece.
      dns.records.delete(txt(CUSTOM));
      await recheckRound();
      await recheckRound();
      expect(await routesToA(CUSTOM)).toBe(true);
      expect((await listOf(A)).find((d) => d.host === CUSTOM)).toMatchObject({
        status: 'VERIFIED',
        failedChecks: 2,
      });
      await recheckRound();

      expect((await listOf(A)).find((d) => d.host === CUSTOM)).toMatchObject({
        status: 'DISABLED',
        failedChecks: 3,
      });
      expect(await routesToA(CUSTOM)).toBe(false);
      // B's verified domain (TXT still published) is untouched.
      expect((await listOf(B)).find((d) => d.host === SQUAT)?.status).toBe(
        'VERIFIED',
      );
    });

    it('the ADMIN can re-verify a DISABLED domain once the TXT is back', async () => {
      const domain = (await listOf(A)).find((d) => d.host === CUSTOM)!;
      dns.records.set(txt(CUSTOM), [domain.verifyToken]);
      await A()
        .post(`/domains/${domain.id}/verify`)
        .expect(201)
        .expect({ status: 'VERIFIED' });
      expect(await routesToA(CUSTOM)).toBe(true);
    });
  });
});

import { LoginLockoutService } from './login-lockout.service';
import {
  DEFAULT_LOGIN_LOCKOUT,
  LoginLockedError,
  accountKeyHash,
  type LoginLockoutConfig,
} from '../domain/login-lockout';
import { InMemoryLoginThrottleRepository } from './__fixtures__/in-memory-login-throttle';

const MIN = 60_000;
const DOCTORA = 'doctora@sonrisa.com';
const CLINIC_IP = '203.0.113.10';

function setup(cfg: Partial<LoginLockoutConfig> = {}) {
  const repo = new InMemoryLoginThrottleRepository();
  const service = new LoginLockoutService(repo, {
    ...DEFAULT_LOGIN_LOCKOUT,
    ...cfg,
  });
  return { repo, service };
}

async function failTimes(
  service: LoginLockoutService,
  n: number,
  email = DOCTORA,
  ip = CLINIC_IP,
): Promise<void> {
  for (let i = 0; i < n; i++) {
    await service.assertCanAttempt(email, ip);
    await service.recordFailure(email, ip);
  }
}

async function retryAfterOf(promise: Promise<unknown>): Promise<number> {
  try {
    await promise;
  } catch (err) {
    if (err instanceof LoginLockedError) return err.retryAfterSeconds;
    throw err;
  }
  return 0;
}

describe('LoginLockoutService (DX-048)', () => {
  it('los logins correctos nunca cuentan: 10 seguidos sin bloqueo', async () => {
    const { service, repo } = setup();
    for (let i = 0; i < 10; i++) {
      await expect(
        service.assertCanAttempt(DOCTORA, CLINIC_IP),
      ).resolves.toBeUndefined();
      await service.recordSuccess(DOCTORA);
    }
    expect(repo.size()).toBe(0);
  });

  it('4 fallos no hacen esperar; el 5.º deja 1 min de espera con Retry-After', async () => {
    const { service } = setup();
    await failTimes(service, 4);
    await expect(
      service.assertCanAttempt(DOCTORA, CLINIC_IP),
    ).resolves.toBeUndefined();
    await service.recordFailure(DOCTORA, CLINIC_IP);
    expect(
      await retryAfterOf(service.assertCanAttempt(DOCTORA, CLINIC_IP)),
    ).toBe(60);
  });

  it('el backoff crece con cada fallo tras la espera (1, 2, 4… min)', async () => {
    const { service, repo } = setup();
    await failTimes(service, 5);
    repo.advance(MIN);
    await failTimes(service, 1);
    expect(
      await retryAfterOf(service.assertCanAttempt(DOCTORA, CLINIC_IP)),
    ).toBe(120);
    repo.advance(2 * MIN);
    await failTimes(service, 1);
    expect(
      await retryAfterOf(service.assertCanAttempt(DOCTORA, CLINIC_IP)),
    ).toBe(240);
  });

  it('la espera nunca pasa de 15 min (sin bloqueo de 1 h)', async () => {
    const { service, repo } = setup();
    for (let i = 0; i < 12; i++) {
      await failTimes(service, 1);
      repo.advance(15 * MIN);
    }
    await failTimes(service, 1);
    expect(
      await retryAfterOf(service.assertCanAttempt(DOCTORA, CLINIC_IP)),
    ).toBe(15 * 60);
  });

  it('un login correcto reinicia el contador de la cuenta', async () => {
    const { service, repo } = setup();
    await failTimes(service, 5);
    repo.advance(MIN);
    await service.assertCanAttempt(DOCTORA, CLINIC_IP);
    await service.recordSuccess(DOCTORA);
    // Vuelve a tener 4 fallos libres.
    await failTimes(service, 4);
    await expect(
      service.assertCanAttempt(DOCTORA, CLINIC_IP),
    ).resolves.toBeUndefined();
  });

  it('el fallo de una cuenta no afecta a la compañera que sale por la misma IP', async () => {
    const { service } = setup();
    await failTimes(service, 5, 'recepcion@sonrisa.com');
    await expect(
      service.assertCanAttempt(DOCTORA, CLINIC_IP),
    ).resolves.toBeUndefined();
  });

  it('fallos desde muchas IPs contra la doctora: solo el backoff, sin bloqueo más largo', async () => {
    const { service, repo } = setup();
    for (let i = 0; i < 5; i++) {
      await failTimes(service, 1, DOCTORA, `198.51.100.${i}`);
    }
    // Desde su propia IP también espera, pero solo el backoff (1 min).
    expect(
      await retryAfterOf(service.assertCanAttempt(DOCTORA, CLINIC_IP)),
    ).toBe(60);
    repo.advance(MIN);
    await expect(
      service.assertCanAttempt(DOCTORA, CLINIC_IP),
    ).resolves.toBeUndefined();
  });

  it('los fallos se olvidan tras LOGIN_LOCKOUT_RESET_MS sin fallar', async () => {
    const { service, repo } = setup();
    await failTimes(service, 4);
    repo.advance(DEFAULT_LOGIN_LOCKOUT.failureMemoryMs + 1);
    await failTimes(service, 4);
    await expect(
      service.assertCanAttempt(DOCTORA, CLINIC_IP),
    ).resolves.toBeUndefined();
  });

  it('el balde por IP solo cuenta fallos y bloquea la IP hasta que acaba su ventana', async () => {
    const { service, repo } = setup({ ipFailureLimit: 3, ipWindowMs: MIN });
    // Éxitos desde la IP: no cuentan.
    for (let i = 0; i < 10; i++) await service.recordSuccess(`ok${i}@x.co`);
    await failTimes(service, 1, 'a@x.co');
    await failTimes(service, 1, 'b@x.co');
    repo.advance(10_000);
    await failTimes(service, 1, 'c@x.co');
    expect(
      await retryAfterOf(service.assertCanAttempt('d@x.co', CLINIC_IP)),
    ).toBe(50);
    // Otra IP no hereda el bloqueo.
    await expect(
      service.assertCanAttempt('d@x.co', '198.51.100.99'),
    ).resolves.toBeUndefined();
    repo.advance(50_000);
    await expect(
      service.assertCanAttempt('d@x.co', CLINIC_IP),
    ).resolves.toBeUndefined();
  });

  it('un éxito NO limpia el balde de la IP (un atacante no lo reinicia con su cuenta)', async () => {
    const { service } = setup({ ipFailureLimit: 2, ipWindowMs: MIN });
    await failTimes(service, 1, 'a@x.co');
    await service.recordSuccess('atacante@x.co');
    await failTimes(service, 1, 'b@x.co');
    expect(
      await retryAfterOf(service.assertCanAttempt('c@x.co', CLINIC_IP)),
    ).toBeGreaterThan(0);
  });

  it('desbloquear borra el contador de la cuenta', async () => {
    const { service } = setup();
    await failTimes(service, 5);
    expect(await service.blockedUntil(DOCTORA)).toBeInstanceOf(Date);
    await service.unlock('  DOCTORA@sonrisa.com');
    expect(await service.blockedUntil(DOCTORA)).toBeNull();
    await expect(
      service.assertCanAttempt(DOCTORA, CLINIC_IP),
    ).resolves.toBeUndefined();
  });

  it('el mismo email con otra capitalización o espacios comparte contador', async () => {
    const { service } = setup();
    await failTimes(service, 5, ' Doctora@Sonrisa.com ');
    expect(
      await retryAfterOf(service.assertCanAttempt(DOCTORA, CLINIC_IP)),
    ).toBe(60);
  });

  it('el repositorio solo ve hashes, nunca el email ni la IP', async () => {
    const { service, repo } = setup();
    await failTimes(service, 1);
    const keys = repo.keys();
    expect(keys).toContain(`ACCOUNT:${accountKeyHash(DOCTORA)}`);
    expect(keys.join(' ')).not.toContain('doctora');
    expect(keys.join(' ')).not.toContain(CLINIC_IP);
  });
});

import { ISO3166_COUNTRIES } from '../../../../../prisma/reference/iso3166';
import {
  BadRequestException,
  ConflictException,
  GoneException,
  NotFoundException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import {
  REGISTRATION_EMAIL_TAKEN,
  REGISTRATION_LINK_EXPIRED,
  REGISTRATION_LINK_INVALID,
  RegisterClinicUseCase,
} from './register-clinic.use-case';
import { PasswordService } from '../../../../shared/crypto/password.service';
import { AuthRepository } from '../../domain/ports/auth-repository.port';
import type {
  PendingRegistrationRecord,
  RegistrationRepository,
} from '../../domain/ports/registration-repository.port';
import type { RegistrationNotifier } from '../../domain/ports/registration-notifier.port';
import { hashRegistrationToken } from '../registration-token';

const createClinic = jest.fn();

function makeRepo(overrides: Partial<AuthRepository> = {}): AuthRepository {
  createClinic.mockReset();
  createClinic.mockResolvedValue({ tenantId: 't1', userId: 'u1' });
  return {
    findUserByEmail: () => Promise.resolve(null),
    findUserForAuth: () => Promise.resolve(null),
    findTenantBySubdomain: () => Promise.resolve(null),
    createClinicWithOwner: createClinic,
    findMembership: () => Promise.resolve(null),
    revokeToken: jest.fn(),
    findSessionState: jest.fn(),
    consumeRefreshToken: jest.fn(),
    ...overrides,
  };
}

/**
 * Pendientes en memoria, con la misma regla de «uno por email» y la de no
 * reemplazar uno vigente creado después de `replaceCreatedBefore` (DX-144).
 */
class InMemoryPending implements RegistrationRepository {
  readonly rows: (PendingRegistrationRecord & {
    tokenHash: string;
    createdAt: Date;
  })[] = [];

  savePending(
    input: Omit<PendingRegistrationRecord, 'id'> & {
      tokenHash: string;
      replaceCreatedBefore: Date;
    },
  ): Promise<boolean> {
    const { replaceCreatedBefore, ...data } = input;
    const i = this.rows.findIndex((r) => r.email === data.email);
    const row = {
      id: `p-${this.rows.length + 1}`,
      ...data,
      createdAt: new Date(),
    };
    if (i < 0) {
      this.rows.push(row);
      return Promise.resolve(true);
    }
    const current = this.rows[i];
    const replaceable =
      current.createdAt < replaceCreatedBefore ||
      current.expiresAt.getTime() <= Date.now();
    if (replaceable) this.rows[i] = row;
    return Promise.resolve(replaceable);
  }

  findPendingByTokenHash(
    tokenHash: string,
  ): Promise<PendingRegistrationRecord | null> {
    return Promise.resolve(
      this.rows.find((r) => r.tokenHash === tokenHash) ?? null,
    );
  }

  consumePending(id: string): Promise<boolean> {
    const i = this.rows.findIndex((r) => r.id === id);
    if (i < 0) return Promise.resolve(false);
    this.rows.splice(i, 1);
    return Promise.resolve(true);
  }
}

function makeNotifier(cooldownSeconds = 0) {
  return {
    recipientCooldownSeconds: cooldownSeconds,
    withinRecipientQuota: jest
      .fn<Promise<boolean>, [string]>()
      .mockResolvedValue(true),
    sendVerification: jest
      .fn<
        Promise<boolean>,
        Parameters<RegistrationNotifier['sendVerification']>
      >()
      .mockResolvedValue(true),
    sendExistingAccountNotice: jest
      .fn<
        Promise<boolean>,
        Parameters<RegistrationNotifier['sendExistingAccountNotice']>
      >()
      .mockResolvedValue(true),
  } satisfies RegistrationNotifier;
}

/** Países de la lista de referencia (el puerto real consulta `countries`). */
const COUNTRIES = {
  has: (code: string) =>
    Promise.resolve(ISO3166_COUNTRIES.some((c) => c.code === code)),
};

/** Monedas admitidas en estos tests (el puerto real consulta `currencies`). */
const CURRENCIES = {
  has: (code: string) => Promise.resolve(['COP', 'JPY'].includes(code)),
};

function newUseCase(
  repo: AuthRepository,
  pending: RegistrationRepository,
  notifier: RegistrationNotifier,
  password: PasswordService,
): RegisterClinicUseCase {
  return new RegisterClinicUseCase(
    repo,
    pending,
    notifier,
    password,
    CURRENCIES,
    COUNTRIES,
  );
}

// G1: la primera sede con sus cuatro valores (datos de test, no defaults).
const TOKYO_LOCATION = {
  locationCountry: 'CO',
  locationCurrency: 'JPY',
  locationTimeZone: 'Asia/Tokyo',
  locationLocale: 'ja-JP',
  locationHourCycle: 'h23',
};

const INPUT = {
  clinicName: 'Sonrisa',
  subdomain: 'Sonrisa',
  email: '  Owner@Clinic.COM ',
  password: 'S3cret!!x',
  fullName: 'Dr. Owner',
  linkBase: 'http://localhost:3001',
  ...TOKYO_LOCATION,
};

/** Forma legada: una web anterior a G1 no envía la sede (ya no se acepta, DX-312). */
const LEGACY_INPUT = {
  clinicName: 'Sonrisa',
  subdomain: 'Sonrisa',
  email: '  Owner@Clinic.COM ',
  password: 'S3cret!!x',
  fullName: 'Dr. Owner',
  linkBase: 'http://localhost:3001',
};

function tokenFrom(url: string): string {
  return url.split('/').pop() as string;
}

describe('RegisterClinicUseCase (DX-029)', () => {
  const realPassword = new PasswordService();

  it('email NUEVO: no crea nada aún; guarda el pendiente (hash, nunca la clave) y envía el enlace', async () => {
    const repo = makeRepo();
    const pending = new InMemoryPending();
    const notifier = makeNotifier();
    const uc = newUseCase(repo, pending, notifier, realPassword);

    const outcome = await uc.execute(INPUT);

    expect(outcome).toBe('VERIFICATION_SENT');
    expect(createClinic).not.toHaveBeenCalled();
    expect(pending.rows).toHaveLength(1);
    expect(pending.rows[0].email).toBe('owner@clinic.com');
    expect(pending.rows[0].subdomain).toBe('sonrisa');
    expect(pending.rows[0].passwordHash).toMatch(/^\$argon2id\$/);
    const { verifyUrl } = notifier.sendVerification.mock.calls[0][0];
    expect(verifyUrl).toMatch(
      /^http:\/\/localhost:3001\/register\/verificar\/[A-Za-z0-9_-]{43}$/,
    );
    // En la BD solo el hash del token.
    expect(pending.rows[0].tokenHash).toBe(
      hashRegistrationToken(tokenFrom(verifyUrl)),
    );
    expect(notifier.sendExistingAccountNotice).not.toHaveBeenCalled();
  });

  it('email YA registrado: no guarda nada, avisa al titular y hace el MISMO hash (sin enumeración por tiempo)', async () => {
    const repo = makeRepo({
      findUserByEmail: () =>
        Promise.resolve({ id: 'u0', fullName: 'Dra. Titular' }),
    });
    const pending = new InMemoryPending();
    const notifier = makeNotifier();
    const password = {
      hash: jest.fn().mockResolvedValue('H'),
      verify: jest.fn(),
    };
    const uc = newUseCase(repo, pending, notifier, password);

    const outcome = await uc.execute(INPUT);

    expect(outcome).toBe('EXISTING_ACCOUNT_NOTIFIED');
    expect(password.hash).toHaveBeenCalledTimes(1);
    expect(pending.rows).toHaveLength(0);
    expect(notifier.sendVerification).not.toHaveBeenCalled();
    expect(notifier.sendExistingAccountNotice).toHaveBeenCalledWith({
      to: 'owner@clinic.com',
      userName: 'Dra. Titular',
      loginUrl: 'http://localhost:3001/login',
    });
  });

  it('accept(): resuelve igual exista o no el email (el trabajo sigue en segundo plano)', async () => {
    const existing = makeRepo({
      findUserByEmail: () => Promise.resolve({ id: 'u0', fullName: 'X' }),
    });
    const fresh = makeRepo();
    const password = {
      hash: jest.fn().mockResolvedValue('H'),
      verify: jest.fn(),
    };
    for (const repo of [existing, fresh]) {
      const uc = newUseCase(
        repo,
        new InMemoryPending(),
        makeNotifier(),
        password,
      );
      await expect(uc.accept(INPUT)).resolves.toBeUndefined();
    }
    expect(password.hash).toHaveBeenCalledTimes(2);
  });

  describe('tope por destinatario y pendiente vigente (DX-144, SEC-034)', () => {
    it('el email de verificación no lleva nada escrito por el solicitante', async () => {
      const notifier = makeNotifier();
      const uc = newUseCase(
        makeRepo(),
        new InMemoryPending(),
        notifier,
        realPassword,
      );
      await uc.execute({
        ...INPUT,
        fullName: 'Tu banco bloqueó tu cuenta: llama al +57 300',
        clinicName: 'Entra en bit.ly/xxxx',
      });
      const [args] = notifier.sendVerification.mock.calls[0];
      expect(Object.keys(args).sort()).toEqual([
        'expiresInHours',
        'to',
        'verifyUrl',
      ]);
      expect(JSON.stringify(args)).not.toMatch(/banco|bit\.ly/);
    });

    it('tope del destinatario alcanzado: ni guarda el pendiente ni envía nada', async () => {
      const pending = new InMemoryPending();
      const notifier = makeNotifier();
      notifier.withinRecipientQuota.mockResolvedValue(false);
      const uc = newUseCase(makeRepo(), pending, notifier, realPassword);

      expect(await uc.execute(INPUT)).toBe('RECIPIENT_QUOTA_REACHED');
      expect(notifier.withinRecipientQuota).toHaveBeenCalledWith(
        'owner@clinic.com',
      );
      expect(pending.rows).toHaveLength(0);
      expect(notifier.sendVerification).not.toHaveBeenCalled();
    });

    it('tope alcanzado con un email ya registrado: tampoco le llega otro aviso', async () => {
      const notifier = makeNotifier();
      notifier.withinRecipientQuota.mockResolvedValue(false);
      const uc = newUseCase(
        makeRepo({
          findUserByEmail: () =>
            Promise.resolve({ id: 'u0', fullName: 'Dra. Titular' }),
        }),
        new InMemoryPending(),
        notifier,
        realPassword,
      );
      expect(await uc.execute(INPUT)).toBe('RECIPIENT_QUOTA_REACHED');
      expect(notifier.sendExistingAccountNotice).not.toHaveBeenCalled();
    });

    it('un segundo registro dentro del enfriamiento no reemplaza el pendiente: el primer enlace sigue valiendo', async () => {
      const pending = new InMemoryPending();
      const notifier = makeNotifier(600);
      const uc = newUseCase(makeRepo(), pending, notifier, realPassword);

      expect(await uc.execute(INPUT)).toBe('VERIFICATION_SENT');
      const firstToken = tokenFrom(
        notifier.sendVerification.mock.calls[0][0].verifyUrl,
      );
      expect(
        await uc.execute({
          ...INPUT,
          subdomain: 'otra',
          password: 'Otra-Clave-2026!',
        }),
      ).toBe('PENDING_KEPT');

      expect(notifier.sendVerification).toHaveBeenCalledTimes(1);
      expect(pending.rows).toHaveLength(1);
      expect(pending.rows[0].subdomain).toBe('sonrisa');
      await expect(
        uc.verify(firstToken, INPUT.password),
      ).resolves.toMatchObject({ subdomain: 'sonrisa' });
    });

    it('pasado el enfriamiento, un registro nuevo sí reemplaza al anterior', async () => {
      const pending = new InMemoryPending();
      const notifier = makeNotifier(600);
      const uc = newUseCase(makeRepo(), pending, notifier, realPassword);
      await uc.execute(INPUT);
      pending.rows[0].createdAt = new Date(Date.now() - 601_000);

      expect(await uc.execute({ ...INPUT, subdomain: 'otra' })).toBe(
        'VERIFICATION_SENT',
      );
      expect(pending.rows).toHaveLength(1);
      expect(pending.rows[0].subdomain).toBe('otra');
      expect(notifier.sendVerification).toHaveBeenCalledTimes(2);
    });

    it('si el tope lo frena al encolar (carrera entre réplicas), el resultado lo dice', async () => {
      const notifier = makeNotifier();
      notifier.sendVerification.mockResolvedValue(false);
      const uc = newUseCase(
        makeRepo(),
        new InMemoryPending(),
        notifier,
        realPassword,
      );
      expect(await uc.execute(INPUT)).toBe('RECIPIENT_QUOTA_REACHED');
    });

    it('accept() no espera al tope: resuelve aunque la comprobación no termine (ni el cuerpo ni el tiempo dependen de él)', async () => {
      const notifier = makeNotifier();
      notifier.withinRecipientQuota.mockReturnValue(new Promise(() => {}));
      const password = {
        hash: jest.fn().mockResolvedValue('H'),
        verify: jest.fn(),
      };
      const uc = newUseCase(
        makeRepo(),
        new InMemoryPending(),
        notifier,
        password,
      );
      await expect(uc.accept(INPUT)).resolves.toBeUndefined();
      expect(password.hash).toHaveBeenCalledTimes(1);
    });
  });

  it('subdominio ocupado: 409 en español (el subdominio es público)', async () => {
    const repo = makeRepo({
      findTenantBySubdomain: () => Promise.resolve({ id: 't0' }),
    });
    const uc = newUseCase(
      repo,
      new InMemoryPending(),
      makeNotifier(),
      realPassword,
    );
    await expect(uc.accept(INPUT)).rejects.toThrow(
      'Ese subdominio ya está en uso. Elige otro.',
    );
  });

  describe('verify', () => {
    async function pendingWithToken() {
      const repo = makeRepo();
      const pending = new InMemoryPending();
      const notifier = makeNotifier();
      const uc = newUseCase(repo, pending, notifier, realPassword);
      await uc.execute(INPUT);
      const { verifyUrl } = notifier.sendVerification.mock.calls[0][0];
      return { repo, pending, uc, token: tokenFrom(verifyUrl) };
    }

    it('crea la clínica con el email VERIFICADO y consume el enlace (un solo uso)', async () => {
      const { pending, uc, token } = await pendingWithToken();

      const result = await uc.verify(token, INPUT.password);

      expect(result).toEqual({
        tenantId: 't1',
        userId: 'u1',
        subdomain: 'sonrisa',
      });
      expect(createClinic).toHaveBeenCalledWith(
        expect.objectContaining({
          email: 'owner@clinic.com',
          subdomain: 'sonrisa',
          emailVerifiedAt: expect.any(Date) as Date,
        }),
      );
      expect(pending.rows).toHaveLength(0);
      await expect(uc.verify(token, INPUT.password)).rejects.toBeInstanceOf(
        NotFoundException,
      );
    });

    it('enlace con forma inválida o desconocido -> 404', async () => {
      const { uc } = await pendingWithToken();
      await expect(uc.verify('nope', INPUT.password)).rejects.toBeInstanceOf(
        NotFoundException,
      );
      await expect(
        uc.verify('A'.repeat(43), INPUT.password),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('contraseña distinta de la del registro -> el MISMO 404 genérico que un enlace desconocido, y el enlace sigue sirviendo', async () => {
      const { pending, uc, token } = await pendingWithToken();

      const wrong = uc.verify(token, 'otra-clave-cualquiera');
      await expect(wrong).rejects.toBeInstanceOf(NotFoundException);
      await expect(wrong).rejects.toThrow(REGISTRATION_LINK_INVALID);
      await expect(uc.verify('A'.repeat(43), INPUT.password)).rejects.toThrow(
        REGISTRATION_LINK_INVALID,
      );
      expect(createClinic).not.toHaveBeenCalled();
      expect(pending.rows).toHaveLength(1);

      // Quien eligió la contraseña sí puede confirmar.
      await expect(uc.verify(token, INPUT.password)).resolves.toMatchObject({
        subdomain: 'sonrisa',
      });
    });

    it('enlace desconocido: verifica igualmente contra un hash ficticio (sin atajo por tiempo)', async () => {
      const password = {
        hash: jest.fn(),
        verify: jest.fn().mockResolvedValue(false),
      };
      const uc = newUseCase(
        makeRepo(),
        new InMemoryPending(),
        makeNotifier(),
        password,
      );
      await expect(uc.verify('nope', 'x')).rejects.toThrow(
        REGISTRATION_LINK_INVALID,
      );
      await expect(uc.verify('A'.repeat(43), 'x')).rejects.toThrow(
        REGISTRATION_LINK_INVALID,
      );
      expect(password.verify).toHaveBeenCalledTimes(2);
    });

    it('enlace caducado con contraseña errónea -> 404 genérico (no confirma que el enlace existió)', async () => {
      const { pending, uc, token } = await pendingWithToken();
      pending.rows[0].expiresAt = new Date(Date.now() - 1000);
      await expect(uc.verify(token, 'mala')).rejects.toThrow(
        REGISTRATION_LINK_INVALID,
      );
    });

    it('enlace caducado -> 410', async () => {
      const { pending, uc, token } = await pendingWithToken();
      pending.rows[0].expiresAt = new Date(Date.now() - 1000);
      await expect(uc.verify(token, INPUT.password)).rejects.toBeInstanceOf(
        GoneException,
      );
    });

    it('el email ya tiene cuenta al verificar -> 409 en español', async () => {
      const { repo, uc, token } = await pendingWithToken();
      repo.findUserByEmail = () => Promise.resolve({ id: 'u9', fullName: 'X' });
      await expect(uc.verify(token, INPUT.password)).rejects.toThrow(
        REGISTRATION_EMAIL_TAKEN,
      );
    });

    it('carrera de índices únicos (P2002) -> 409, no 500', async () => {
      const { uc, token } = await pendingWithToken();
      createClinic.mockRejectedValue(
        new Prisma.PrismaClientKnownRequestError('dup', {
          code: 'P2002',
          clientVersion: 'x',
        }),
      );
      await expect(uc.verify(token, INPUT.password)).rejects.toBeInstanceOf(
        ConflictException,
      );
    });
  });

  describe('primera sede (G1, spec §3.5)', () => {
    it('guarda la sede canónica en el pendiente y verify crea la clínica con ella', async () => {
      const repo = makeRepo();
      const pending = new InMemoryPending();
      const notifier = makeNotifier();
      const uc = newUseCase(repo, pending, notifier, realPassword);

      await uc.execute({
        ...INPUT,
        locationCurrency: ' jpy ',
        locationLocale: 'JA-jp',
      });
      expect(pending.rows[0].location).toEqual({
        country: 'CO',
        currency: 'JPY',
        timeZone: 'Asia/Tokyo',
        locale: 'ja-JP',
        hourCycle: 'h23',
      });

      const { verifyUrl } = notifier.sendVerification.mock.calls[0][0];
      await uc.verify(tokenFrom(verifyUrl), INPUT.password);
      expect(createClinic).toHaveBeenCalledWith(
        expect.objectContaining({
          location: {
            country: 'CO',
            currency: 'JPY',
            timeZone: 'Asia/Tokyo',
            locale: 'ja-JP',
            hourCycle: 'h23',
          },
        }),
      );
    });

    it('G1-B: con los cinco guarda el reloj elegido (12 h)', async () => {
      const pending = new InMemoryPending();
      const uc = newUseCase(makeRepo(), pending, makeNotifier(), realPassword);
      await uc.execute({
        ...INPUT,
        locationCurrency: 'JPY',
        locationLocale: 'en-US',
        locationTimeZone: 'America/New_York',
        locationHourCycle: 'h12',
      });
      expect(pending.rows[0].location).toEqual({
        country: 'CO',
        currency: 'JPY',
        timeZone: 'America/New_York',
        locale: 'en-US',
        hourCycle: 'h12',
      });
    });

    it('G1-B fase 1: los cuatro sin reloj (web de G1) no son legado: hourCycle null', async () => {
      const pending = new InMemoryPending();
      const uc = newUseCase(makeRepo(), pending, makeNotifier(), realPassword);
      await uc.execute({ ...INPUT, locationHourCycle: undefined });
      expect(pending.rows[0].location).toEqual({
        country: 'CO',
        currency: 'JPY',
        timeZone: 'Asia/Tokyo',
        locale: 'ja-JP',
        hourCycle: null,
      });
    });

    it('G1-B: locationHourCycle solo es 400 con el primer campo que falta', async () => {
      const pending = new InMemoryPending();
      const uc = newUseCase(makeRepo(), pending, makeNotifier(), realPassword);
      const error = await uc
        .execute({ ...LEGACY_INPUT, locationHourCycle: 'h12' })
        .catch((e: unknown) => e);
      expect((error as BadRequestException).getResponse()).toMatchObject({
        message: 'Elige el país de la sede.',
        field: 'locationCountry',
      });
      const invalid = await uc
        .execute({ ...INPUT, locationHourCycle: 'h24' })
        .catch((e: unknown) => e);
      expect((invalid as BadRequestException).getResponse()).toMatchObject({
        message: 'El reloj «h24» no es válido: elige 12 h o 24 h.',
        field: 'locationHourCycle',
      });
      expect(pending.rows).toHaveLength(0);
    });

    it('registration checks locationCountry with the same messages', async () => {
      const pending = new InMemoryPending();
      const uc = newUseCase(makeRepo(), pending, makeNotifier(), realPassword);
      const cases: [unknown, string][] = [
        [null, 'Elige el país de la sede.'],
        ['xx', 'El país «XX» no está en la lista de países.'],
        ['x'.repeat(500), 'El país indicado no está en la lista de países.'],
      ];
      for (const [locationCountry, message] of cases) {
        for (const call of [uc.execute.bind(uc), uc.accept.bind(uc)]) {
          const error = await call({
            ...INPUT,
            locationCountry: locationCountry as string,
          }).catch((e: unknown) => e);
          expect((error as BadRequestException).getResponse()).toMatchObject({
            message,
            field: 'locationCountry',
          });
        }
      }
      expect(pending.rows).toHaveLength(0);
    });

    it('registration normalizes a listed country outside the old pair', async () => {
      const pending = new InMemoryPending();
      const uc = newUseCase(makeRepo(), pending, makeNotifier(), realPassword);
      await uc.execute({ ...INPUT, locationCountry: ' ve ' });
      expect(pending.rows[0].location?.country).toBe('VE');
    });

    it('legacy registration without location fields is 400 with field locationCountry', async () => {
      const pending = new InMemoryPending();
      const uc = newUseCase(makeRepo(), pending, makeNotifier(), realPassword);

      for (const call of [uc.execute.bind(uc), uc.accept.bind(uc)]) {
        const error = await call(LEGACY_INPUT).catch((e: unknown) => e);
        expect(error).toBeInstanceOf(BadRequestException);
        expect((error as BadRequestException).getResponse()).toMatchObject({
          message: 'Elige el país de la sede.',
          field: 'locationCountry',
        });
      }
      expect(pending.rows).toHaveLength(0);
    });

    it('verify with a pending without location throws Gone before consuming it', async () => {
      const repo = makeRepo();
      const pending = new InMemoryPending();
      const notifier = makeNotifier();
      const uc = newUseCase(repo, pending, notifier, realPassword);

      expect(await uc.execute(INPUT)).toBe('VERIFICATION_SENT');
      pending.rows[0].location = null;
      const consume = jest.spyOn(pending, 'consumePending');
      const { verifyUrl } = notifier.sendVerification.mock.calls[0][0];
      const error = await uc
        .verify(tokenFrom(verifyUrl), INPUT.password)
        .catch((e: unknown) => e);
      expect(error).toBeInstanceOf(GoneException);
      expect((error as GoneException).getResponse()).toMatchObject({
        message: REGISTRATION_LINK_EXPIRED,
      });
      expect(consume).not.toHaveBeenCalled();
      expect(createClinic).not.toHaveBeenCalled();
      expect(pending.rows).toHaveLength(1);
    });

    it.each([
      ['locationCountry', 'Elige el país de la sede.'],
      ['locationCurrency', 'Elige la moneda de la sede.'],
      ['locationTimeZone', 'Elige la zona horaria de la sede.'],
      ['locationLocale', 'Elige el formato regional de la sede.'],
    ] as const)(
      'un subconjunto (falta %s) es 400 con su mensaje y no guarda nada',
      async (field, message) => {
        const pending = new InMemoryPending();
        const notifier = makeNotifier();
        const uc = newUseCase(makeRepo(), pending, notifier, realPassword);
        for (const call of [uc.execute.bind(uc), uc.accept.bind(uc)]) {
          const error = await call({ ...INPUT, [field]: undefined }).catch(
            (e: unknown) => e,
          );
          expect(error).toBeInstanceOf(BadRequestException);
          expect((error as BadRequestException).getResponse()).toMatchObject({
            message,
            field,
          });
        }
        expect(pending.rows).toHaveLength(0);
        expect(notifier.withinRecipientQuota).not.toHaveBeenCalled();
      },
    );

    it('moneda que no está en la lista, zona inexistente o formato inválido: 400', async () => {
      const uc = newUseCase(
        makeRepo(),
        new InMemoryPending(),
        makeNotifier(),
        realPassword,
      );
      const cases = [
        [
          { locationCurrency: 'XYZ' },
          'locationCurrency',
          'La moneda XYZ no está en la lista de monedas admitidas.',
        ],
        [
          { locationTimeZone: 'Mars/Olympus' },
          'locationTimeZone',
          'La zona horaria «Mars/Olympus» no existe.',
        ],
        [
          { locationLocale: 'not a locale' },
          'locationLocale',
          'El formato regional «not a locale» no es válido.',
        ],
      ] as const;
      for (const [patch, field, message] of cases) {
        const error = await uc
          .execute({ ...INPUT, ...patch })
          .catch((e: unknown) => e);
        expect((error as BadRequestException).getResponse()).toMatchObject({
          field,
          message,
        });
      }
    });
  });
});

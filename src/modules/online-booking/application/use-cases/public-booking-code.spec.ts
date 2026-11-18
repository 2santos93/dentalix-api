import { TenantContextService } from '../../../../shared/tenancy/tenant-context.service';
import { ConfigService } from '@nestjs/config';
import {
  RequestBookingCodeUseCase,
  VerifyBookingCodeUseCase,
} from './public-booking.use-cases';
import {
  NoBotChallengeVerifier,
  deriveBookingKey,
  hmacBookingCode,
  issueFormToken,
} from '../../domain/booking-security';
import { DEFAULT_ONLINE_BOOKING_SETTINGS } from '../../domain/online-booking-settings';
import type { OnlineBookingRepository } from '../../domain/ports/online-booking-repository.port';
import type { OnlineSlotService } from '../online-slot.service';
import type { OnlineBookingEmail } from '../online-booking-email';

// DX-016 (revisión de seguridad): pedir el código responde igual y sin
// esperar a la búsqueda de la ficha (que va después de responder); verificar
// cuenta el intento antes de comparar.
const SECRET = 'secreto-de-prueba';
const TENANT = '11111111-1111-4111-8111-111111111111';
const NOW = new Date('2026-11-20T12:00:00Z');

function setup(repo: Partial<OnlineBookingRepository>) {
  const tenantContext = new TenantContextService();
  const config = { getOrThrow: () => SECRET } as unknown as ConfigService;
  const full = {
    getSettings: jest.fn().mockResolvedValue({
      ...DEFAULT_ONLINE_BOOKING_SETTINGS,
      enabled: true,
    }),
    createVerification: jest.fn().mockResolvedValue(undefined),
    ...repo,
  } as unknown as OnlineBookingRepository;
  const email = { sendCode: jest.fn() } as unknown as OnlineBookingEmail;
  const slots = {} as OnlineSlotService;
  const clock = () => NOW;
  const request = new RequestBookingCodeUseCase(
    full,
    tenantContext,
    slots,
    clock,
    new NoBotChallengeVerifier(),
    config,
    email,
  );
  const verify = new VerifyBookingCodeUseCase(
    full,
    tenantContext,
    slots,
    clock,
    new NoBotChallengeVerifier(),
    config,
  );
  const formToken = issueFormToken(
    deriveBookingKey(SECRET, 'form'),
    TENANT,
    new Date(NOW.getTime() - 10_000),
  );
  return { tenantContext, request, verify, full, email, formToken };
}

const meta = { requestId: null, ip: null, userAgent: null };
const who = {
  firstName: 'María',
  lastName: 'Pérez',
  birthDate: '1990-05-14',
  email: 'maria.perez@example.com',
};

describe('pedir el código de la reserva online (DX-016)', () => {
  it('responde sin esperar a la búsqueda de la ficha, con una verificación sin paciente, exista o no', async () => {
    let lookups = 0;
    const { tenantContext, request, full, formToken } = setup({
      // Una búsqueda que nunca acaba: la respuesta no puede depender de ella.
      findExistingPatients: jest.fn(() => {
        lookups++;
        return new Promise<string[]>(() => undefined);
      }),
    });
    const res = await tenantContext.run(TENANT, () =>
      request.execute({ ...who, formToken }, meta),
    );
    expect(Object.keys(res).sort()).toEqual([
      'expiresAt',
      'message',
      'verificationId',
    ]);
    expect(lookups).toBe(0);
    expect(full.createVerification).toHaveBeenCalledWith(
      expect.objectContaining({ patientId: null }),
      meta,
    );
  });

  it('las dos ramas (ficha que casa y que no) devuelven exactamente lo mismo salvo el id', async () => {
    const run = async (matches: string[]) => {
      const { tenantContext, request, formToken } = setup({
        findExistingPatients: jest.fn().mockResolvedValue(matches),
        countCodesSince: jest.fn().mockResolvedValue(0),
        attachPatient: jest.fn().mockResolvedValue(true),
        catalog: jest.fn(),
      });
      const res = await tenantContext.run(TENANT, () =>
        request.execute({ ...who, formToken }, meta),
      );
      return { ...res, verificationId: 'x' };
    };
    expect(await run(['22222222-2222-4222-8222-222222222222'])).toEqual(
      await run([]),
    );
  });

  it('tras responder, solo con UNA ficha que casa se liga y se envía el código a ese email', async () => {
    const attachPatient = jest.fn().mockResolvedValue(true);
    const { tenantContext, request, email } = setup({
      findExistingPatients: jest
        .fn()
        .mockResolvedValue(['22222222-2222-4222-8222-222222222222']),
      countCodesSince: jest.fn().mockResolvedValue(0),
      attachPatient,
      catalog: jest
        .fn()
        .mockResolvedValue({ clinicName: 'Clínica Ávila', locations: [] }),
    });
    await tenantContext.run(TENANT, () =>
      request.deliver('v1', who, NOW, meta),
    );
    expect(attachPatient).toHaveBeenCalled();
    expect(email.sendCode).toHaveBeenCalledWith(
      expect.objectContaining({ to: 'maria.perez@example.com' }),
    );
  });
});

describe('verificar el código (DX-016)', () => {
  const key = deriveBookingKey(SECRET, 'code');
  const row = (attempts: number) => ({
    id: 'v1',
    patientId: '22222222-2222-4222-8222-222222222222',
    patientKind: 'EXISTING' as const,
    codeHmac: hmacBookingCode(key, 'v1', '123456'),
    codeExpiresAt: new Date(NOW.getTime() + 60_000),
    attempts,
    verifiedAt: null,
    lockedAt: null,
  });

  it('sin intento contado (tope, caducado, usado) no se compara: 400', async () => {
    const markVerified = jest.fn();
    const { tenantContext, verify } = setup({
      claimAttempt: jest.fn().mockResolvedValue(null),
      markVerified,
    });
    await expect(
      tenantContext.run(TENANT, () => verify.execute('v1', '123456', meta)),
    ).rejects.toThrow('El código no es correcto');
    expect(markVerified).not.toHaveBeenCalled();
  });

  it('el fallo que llega al tope bloquea; el acierto abre sesión', async () => {
    const lockIfExhausted = jest.fn().mockResolvedValue(true);
    const { tenantContext, verify } = setup({
      claimAttempt: jest.fn().mockResolvedValue(row(5)),
      lockIfExhausted,
      markVerified: jest.fn().mockResolvedValue(true),
    });
    await expect(
      tenantContext.run(TENANT, () => verify.execute('v1', '000000', meta)),
    ).rejects.toThrow();
    expect(lockIfExhausted).toHaveBeenCalledWith(row(5), 5, meta);
    const ok = await tenantContext.run(TENANT, () =>
      verify.execute('v1', '123456', meta),
    );
    expect(ok.sessionToken).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });
});

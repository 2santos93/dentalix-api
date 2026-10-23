import {
  BadRequestException,
  CallHandler,
  ExecutionContext,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { lastValueFrom, of, throwError } from 'rxjs';
import { AuditInterceptor } from './audit.interceptor';
import { AUDIT_OPTIONS, type AuditOptions } from './audit-options';
import type { AuditedRequest } from './audit-request';
import { TenantContextService } from '../../../shared/tenancy/tenant-context.service';
import { requestContext } from '../../../shared/observability/request-context';
import type { RecordAuditEventUseCase } from '../application/record-audit-event.use-case';
import type { AuditEventDraft } from '../domain/audit-event';

const TENANT = '11111111-1111-4111-8111-111111111111';
const USER = '22222222-2222-4222-8222-222222222222';
const PATIENT = '33333333-3333-4333-8333-333333333333';
const LOCATION = '44444444-4444-4444-8444-444444444444';

function handlerWith(options: AuditOptions | undefined): () => void {
  const handler = (): void => undefined;
  if (options) Reflect.defineMetadata(AUDIT_OPTIONS, options, handler);
  return handler;
}

function ctx(req: AuditedRequest, handler: () => void): ExecutionContext {
  return {
    getType: () => 'http',
    getHandler: () => handler,
    switchToHttp: () => ({ getRequest: () => req }),
  } as unknown as ExecutionContext;
}

function setup() {
  const drafts: AuditEventDraft[] = [];
  const record = jest.fn((draft: AuditEventDraft): Promise<void> => {
    drafts.push(draft);
    return Promise.resolve();
  });
  const recorder = { record } as unknown as RecordAuditEventUseCase;
  const tenantContext = new TenantContextService();
  const interceptor = new AuditInterceptor(
    new Reflector(),
    recorder,
    tenantContext,
  );
  /** Ejecuta como en la app: request id (DX-023) y tenant/sede en contexto. */
  const run = <T>(
    req: AuditedRequest,
    options: AuditOptions | undefined,
    next: CallHandler<T>,
    tenant: string | null = TENANT,
  ): Promise<T> =>
    requestContext.run({ requestId: 'req-00000042' }, () => {
      const call = () =>
        lastValueFrom(
          interceptor.intercept(ctx(req, handlerWith(options)), next),
        );
      return tenant ? tenantContext.run(tenant, LOCATION, call) : call();
    }) as Promise<T>;
  return { drafts, recorder: { record }, run };
}

const clinicalReq = (): AuditedRequest => ({
  ip: '198.51.100.4',
  headers: { 'user-agent': 'Firefox' },
  params: { patientId: PATIENT },
  user: { sub: USER, tenantId: TENANT, role: 'ASSISTANT' },
});

const VIEW_HISTORY: AuditOptions = {
  action: 'VIEW',
  resource: 'MEDICAL_HISTORY',
  patient: { param: 'patientId' },
};

describe('AuditInterceptor (DX-009)', () => {
  it('sin @Audit no hace nada', async () => {
    const { recorder, run } = setup();
    await expect(
      run(clinicalReq(), undefined, { handle: () => of('ok') }),
    ).resolves.toBe('ok');
    expect(recorder.record).not.toHaveBeenCalled();
  });

  it('tras el éxito escribe UN evento (una sola escritura) y devuelve la respuesta intacta', async () => {
    const { drafts, run } = setup();
    const body = { allergies: 'Penicilina' };
    await expect(
      run(clinicalReq(), VIEW_HISTORY, { handle: () => of(body) }),
    ).resolves.toBe(body);
    expect(drafts).toHaveLength(1);
    expect(drafts[0]).toMatchObject({
      tenantId: TENANT,
      locationId: LOCATION,
      actor: { kind: 'user', userId: USER, role: 'ASSISTANT' },
      action: 'VIEW',
      resourceType: 'MEDICAL_HISTORY',
      patient: { kind: 'patient', id: PATIENT },
      requestId: 'req-00000042',
      ip: '198.51.100.4',
      userAgent: 'Firefox',
    });
    expect(JSON.stringify(drafts)).not.toContain('Penicilina');
  });

  it('DX-259: si el handler marca la petición como ya auditada (repetición idempotente), no escribe otro evento', async () => {
    const { recorder, run } = setup();
    const req = clinicalReq();
    await expect(
      run(req, VIEW_HISTORY, {
        handle: () => {
          req.skipAudit = true;
          return of('ok');
        },
      }),
    ).resolves.toBe('ok');
    expect(recorder.record).not.toHaveBeenCalled();
  });

  it('la respuesta espera a que el evento quede escrito (orden determinista)', async () => {
    const { recorder, run } = setup();
    let written = false;
    recorder.record.mockImplementation(
      () =>
        new Promise<void>((resolve) =>
          setTimeout(() => {
            written = true;
            resolve();
          }, 5),
        ),
    );
    await run(clinicalReq(), VIEW_HISTORY, { handle: () => of('ok') });
    expect(written).toBe(true);
  });

  it('si el handler falla no se registra nada y el error sigue su camino', async () => {
    const { recorder, run } = setup();
    await expect(
      run(clinicalReq(), VIEW_HISTORY, {
        handle: () => throwError(() => new NotFoundException()),
      }),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(recorder.record).not.toHaveBeenCalled();
  });

  describe('login', () => {
    const LOGIN: AuditOptions = { action: 'LOGIN', resource: 'SESSION' };
    const token = `h.${Buffer.from(JSON.stringify({ sub: USER, tenantId: TENANT, role: 'RECEPTION' })).toString('base64url')}.s`;
    const loginReq = (tenantId: string | null): AuditedRequest => ({
      ip: '192.0.2.10',
      headers: { 'user-agent': 'Safari' },
      params: {},
      body: { email: 'Recepcion@Clinica.test', password: 'S3cret!!' },
      tenantHost: { host: 'clinica.localhost', tenantId },
    });

    it('correcto: LOGIN con el usuario y el rol del token emitido, en el tenant del host', async () => {
      const { drafts, run } = setup();
      await run(
        loginReq(TENANT),
        LOGIN,
        { handle: () => of({ accessToken: token }) },
        null,
      );
      expect(drafts).toEqual([
        expect.objectContaining({
          tenantId: TENANT,
          locationId: null,
          actor: { kind: 'user', userId: USER, role: 'RECEPTION' },
          action: 'LOGIN',
          resourceType: 'SESSION',
          ip: '192.0.2.10',
          requestId: 'req-00000042',
        }),
      ]);
      expect(JSON.stringify(drafts)).not.toMatch(/S3cret|accessToken/);
    });

    it('fallido (401): LOGIN_FAILED con el email como pista del actor, y el 401 sale igual', async () => {
      const { drafts, run } = setup();
      await expect(
        run(
          loginReq(TENANT),
          LOGIN,
          {
            handle: () =>
              throwError(
                () => new UnauthorizedException('Invalid credentials'),
              ),
          },
          null,
        ),
      ).rejects.toBeInstanceOf(UnauthorizedException);
      expect(drafts).toEqual([
        expect.objectContaining({
          action: 'LOGIN_FAILED',
          resourceType: 'SESSION',
          actor: { kind: 'email', email: 'Recepcion@Clinica.test' },
          metadata: { reason: 'INVALID_CREDENTIALS' },
        }),
      ]);
      expect(JSON.stringify(drafts)).not.toContain('S3cret');
    });

    it('un 400 de validación no es un intento de login: nada', async () => {
      const { recorder, run } = setup();
      await expect(
        run(
          loginReq(TENANT),
          LOGIN,
          { handle: () => throwError(() => new BadRequestException()) },
          null,
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(recorder.record).not.toHaveBeenCalled();
    });

    it('en el apex (sin clínica) no se audita: es la plataforma (DX-031)', async () => {
      const { recorder, run } = setup();
      await run(
        loginReq(null),
        LOGIN,
        { handle: () => of({ accessToken: token }) },
        null,
      );
      await expect(
        run(
          loginReq(null),
          LOGIN,
          { handle: () => throwError(() => new UnauthorizedException()) },
          null,
        ),
      ).rejects.toBeInstanceOf(UnauthorizedException);
      expect(recorder.record).not.toHaveBeenCalled();
    });
  });
});

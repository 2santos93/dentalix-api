import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  HttpException,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { FixedDocumentTypeNamesReader } from '../../../document-type-names/__fixtures__/fixed-document-type-names.reader';
import { InMemoryConsentTemplateRepository } from '../../../consents/application/__fixtures__/in-memory-consent-templates';
import { InMemoryPatientConsentRepository } from '../../../consents/application/__fixtures__/in-memory-patient-consents';
import { ConsentDocumentRenderer } from '../../../consents/application/use-cases/patient-consents.use-cases';
import { computeRemoteConsentHash } from '../../../consents/domain/consent-hash';
import type {
  SignatureBudgetAcceptedEmailVars,
  SignatureCodeEmailVars,
  SignatureRequestEmailVars,
} from '../../../notifications/email/domain/email-message';
import { quoteSource } from '../../../treatment-plans/application/use-cases/__fixtures__/in-memory-plan-quote.repository';
import { computeQuoteHash } from '../../../treatment-plans/domain/plan-quote';
import { RemoteBudgetCheck } from '../remote-budget';
import { TenantContextService } from '../../../../shared/tenancy/tenant-context.service';
import type { SignatureRecipientContext } from '../../domain/ports/signature-request-repository.port';
import { deriveSignatureCodeKey } from '../../domain/signature-code';
import { hashSignatureToken } from '../../domain/signature-token';
import { InMemorySignatureRequestRepository } from '../__fixtures__/in-memory-signature-requests';
import type { SignatureEmailSender } from '../signature-email';
import {
  GetPublicSignatureDocumentUseCase,
  GetPublicSignatureUseCase,
  RequestSignatureCodeUseCase,
  SIGNATURE_LINK_INVALID_MESSAGE,
  SignPublicSignatureUseCase,
  VerifySignatureCodeUseCase,
} from './public-signature.use-cases';
import {
  CreateSignatureRequestUseCase,
  GetSignatureRequestOptionsUseCase,
  ListPatientSignatureRequestsUseCase,
  RevokeSignatureRequestUseCase,
  SIGNATURE_BUDGET_PLAN_REQUIRED_MESSAGE,
  SIGNATURE_PROFESSIONAL_INVALID_MESSAGE,
  SIGNATURE_PROFESSIONAL_REQUIRED_MESSAGE,
} from './signature-requests.use-cases';

const PNG =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';
const SENT_AT = new Date('2026-10-30T14:00:00.000Z');
const EVIDENCE = {
  ipAddress: '203.0.113.7',
  userAgent: 'Mobile',
  requestId: null,
};
const DENTIST = { userId: 'dentist-1', clinical: true };
const RECEPTION = { userId: 'reception-1', clinical: false };
const LINK = { protocol: 'https', host: 'demo.dentalix.app' };

function recipient(
  partial: Partial<SignatureRecipientContext['patient']> = {},
  responsibles: SignatureRecipientContext['responsibles'] = [],
): SignatureRecipientContext {
  return {
    patient: {
      firstName: 'Ana',
      lastName: 'Pérez',
      birthDate: new Date('1990-01-01T00:00:00.000Z'),
      email: 'ana.perez@example.com',
      emergencyContactName: null,
      reminderOptOutAt: null,
      contactChannel: 'EMAIL',
      ...partial,
    },
    responsibles,
    majorityAge: 18,
    timeZone: 'America/Bogota',
  };
}

function setup() {
  let now = SENT_AT;
  const clock = () => now;
  const templates = new InMemoryConsentTemplateRepository();
  const consents = new InMemoryPatientConsentRepository();
  consents.location = { id: 'loc-1', locale: 'es-CO', hourCycle: 'h12' };
  consents.timeZone = 'America/Bogota';
  const template = templates.seed({
    title: 'Consentimiento de exodoncia',
    body: 'Yo, {{paciente}} ({{documento}}), autorizo a {{profesional}}.',
  });
  const names = new FixedDocumentTypeNamesReader();
  const renderer = new ConsentDocumentRenderer(templates, consents, names);
  const repo = new InMemorySignatureRequestRepository({ p1: recipient() });
  const links: { to: string; vars: SignatureRequestEmailVars }[] = [];
  const codes: { to: string; vars: SignatureCodeEmailVars }[] = [];
  const cancelled: string[] = [];
  const confirmations: {
    to: string;
    vars: SignatureBudgetAcceptedEmailVars;
  }[] = [];
  const email: SignatureEmailSender = {
    sendBudgetAccepted: (input) => {
      confirmations.push(input);
      return Promise.resolve();
    },
    assertCanSend: () => Promise.resolve(),
    sendLink: (input) => {
      links.push(input);
      return Promise.resolve();
    },
    sendCode: (input) => {
      codes.push(input);
      return Promise.resolve();
    },
    cancelPendingLink: (id) => {
      cancelled.push(id);
      return Promise.resolve();
    },
  };
  const tenantContext = new TenantContextService();
  const key = deriveSignatureCodeKey(
    'secreto-de-prueba-con-mas-de-32-caracteres',
  );
  const inTenant = <T>(fn: () => Promise<T>) => tenantContext.run('t1', fn);
  const budgets = new RemoteBudgetCheck(repo, names);
  return {
    confirmations,
    repo,
    consents,
    template,
    tenantContext,
    links,
    codes,
    cancelled,
    advance: (ms: number) => {
      now = new Date(now.getTime() + ms);
    },
    options: new GetSignatureRequestOptionsUseCase(
      repo,
      templates,
      names,
      clock,
    ),
    create: new CreateSignatureRequestUseCase(
      repo,
      renderer,
      names,
      email,
      tenantContext,
      clock,
    ),
    list: new ListPatientSignatureRequestsUseCase(repo, clock),
    revoke: new RevokeSignatureRequestUseCase(
      repo,
      email,
      tenantContext,
      clock,
    ),
    view: new GetPublicSignatureUseCase(tenantContext, repo, budgets, clock),
    code: new RequestSignatureCodeUseCase(
      tenantContext,
      repo,
      budgets,
      email,
      key,
      clock,
    ),
    verify: new VerifySignatureCodeUseCase(
      tenantContext,
      repo,
      budgets,
      key,
      clock,
    ),
    document: new GetPublicSignatureDocumentUseCase(
      tenantContext,
      repo,
      budgets,
      clock,
    ),
    sign: new SignPublicSignatureUseCase(
      tenantContext,
      repo,
      budgets,
      email,
      clock,
    ),
    inTenant,
  };
}

type Ctx = ReturnType<typeof setup>;

function tokenOf(ctx: Ctx, index = -1): string {
  const url = ctx.links.at(index)?.vars.url ?? '';
  const match = /\/firmar\/([A-Za-z0-9_-]{43})$/.exec(url);
  if (!match) throw new Error(`URL sin token: ${url}`);
  return match[1];
}

async function send(ctx: Ctx, actor = DENTIST, extra = {}) {
  return ctx.create.execute(
    'p1',
    {
      type: 'CONSENT',
      channel: 'EMAIL',
      templateId: ctx.template.id,
      ...extra,
    },
    actor,
    LINK,
  );
}

async function verified(ctx: Ctx) {
  await send(ctx);
  const token = tokenOf(ctx);
  await ctx.inTenant(() => ctx.code.execute(token, EVIDENCE));
  const code = ctx.codes.at(-1)!.vars.code;
  const session = await ctx.inTenant(() =>
    ctx.verify.execute(token, code, EVIDENCE),
  );
  return { token, session: session.sessionToken };
}

describe('enviar a firmar a distancia (DX-243)', () => {
  it('congela el texto, guarda solo el hash del token y envía el enlace por email sin nada clínico', async () => {
    const ctx = setup();
    const created = await send(ctx);
    const [row] = ctx.repo.rows;
    expect(row.body).toBe(
      'Yo, Ana Pérez (Documento nacional 1020304050), autorizo a Dra. Laura Gómez.',
    );
    expect(row.templateVersion).toBe(1);
    expect(row.expiresAt).toEqual(new Date('2026-11-02T14:00:00.000Z'));
    expect(row.destinationMasked).toBe('an***@example.com');
    expect(row.signerType).toBe('PATIENT');
    expect(row.tokenHash).toBe(hashSignatureToken(tokenOf(ctx)));
    expect(JSON.stringify(row)).not.toContain(tokenOf(ctx));
    expect(created).toMatchObject({ status: 'SENT', emailQueued: true });
    const mail = ctx.links[0];
    expect(mail.to).toBe('ana.perez@example.com');
    expect(mail.vars).toMatchObject({
      recipientFirstName: 'Ana',
      patientFirstName: null,
    });
    expect(JSON.stringify(mail.vars)).not.toMatch(/exodoncia/i);
  });

  it('recepción tiene que elegir el profesional que firmará; uno que no es clínico es 400', async () => {
    const ctx = setup();
    await expect(send(ctx, RECEPTION)).rejects.toThrow(
      SIGNATURE_PROFESSIONAL_REQUIRED_MESSAGE,
    );
    await expect(
      send(ctx, RECEPTION, { professionalId: 'reception-1' }),
    ).rejects.toBeInstanceOf(BadRequestException);
    await send(ctx, RECEPTION, { professionalId: 'dentist-1' });
    expect(ctx.repo.rows[0]).toMatchObject({
      professionalUserId: 'dentist-1',
      createdById: 'reception-1',
    });
  });

  it('SEC-045: un miembro restringido a otra sede no envía (la solicitud iría a una sede que no es suya)', async () => {
    const ctx = setup();
    await expect(
      ctx.tenantContext.run('t1', undefined, () => send(ctx), ['loc-2']),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(ctx.repo.rows).toHaveLength(0);
    expect(ctx.links).toHaveLength(0);
    await ctx.tenantContext.run('t1', undefined, () => send(ctx), ['loc-1']);
    expect(ctx.repo.rows[0].locationId).toBe('loc-1');
  });

  it('un menor: va al responsable, que firma como GUARDIAN con su nombre', async () => {
    const ctx = setup();
    ctx.repo.recipients.p1 = recipient(
      {
        birthDate: new Date('2015-02-11T00:00:00.000Z'),
        email: 'familia@example.com',
      },
      [
        {
          id: 'r1',
          name: 'Claudia Navarro',
          email: 'claudia@example.com',
          isPayer: false,
          receivesNotices: true,
          optedOut: false,
          document: {
            docType: 'NATIONAL_ID',
            docTypeLabel: null,
            docNumber: 'C01',
          },
        },
      ],
    );
    await send(ctx);
    expect(ctx.repo.rows[0]).toMatchObject({
      signerType: 'GUARDIAN',
      signerName: 'Claudia Navarro',
      signerDocument: 'Documento nacional C01',
      destination: 'claudia@example.com',
      destinationMasked: 'cl***@example.com',
    });
    expect(ctx.links[0].vars).toMatchObject({
      recipientFirstName: 'Claudia',
      patientFirstName: 'Ana',
    });
  });

  it('sin email del paciente: 422 y no se crea nada', async () => {
    const ctx = setup();
    ctx.repo.recipients.p1 = recipient({ email: null });
    await expect(send(ctx)).rejects.toBeInstanceOf(
      UnprocessableEntityException,
    );
    expect(ctx.repo.rows).toHaveLength(0);
  });

  it('un segundo envío del mismo documento anula el anterior y cancela su email pendiente', async () => {
    const ctx = setup();
    const first = await send(ctx);
    await send(ctx);
    const list = await ctx.list.execute('p1');
    expect(list.map((r) => r.status)).toEqual(['SENT', 'REVOKED']);
    expect(ctx.cancelled).toEqual([first.id]);
  });

  it('las opciones del modal dicen a quién iría (enmascarado) y el profesional por defecto', async () => {
    const ctx = setup();
    expect(await ctx.options.execute('p1', DENTIST)).toMatchObject({
      templates: [
        {
          id: ctx.template.id,
          title: 'Consentimiento de exodoncia',
          version: 1,
        },
      ],
      defaultProfessionalId: 'dentist-1',
      recipient: {
        allowed: true,
        destinationMasked: 'an***@example.com',
        signerType: 'PATIENT',
      },
    });
    expect(
      (await ctx.options.execute('p1', RECEPTION)).defaultProfessionalId,
    ).toBeNull();
    await expect(ctx.options.execute('p2', DENTIST)).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });
});

describe('opciones del modal «Enviar a firmar» (QA DX-243)', () => {
  it('solo ofrece profesionales que firman como en la clínica (roles clínicos, con su rol); el por defecto es quien envía solo si es uno de ellos', async () => {
    const ctx = setup();
    ctx.repo.professionals = [
      { id: 'dentist-1', fullName: 'Dra. Laura Gómez', role: 'DENTIST' },
      { id: 'assistant-1', fullName: 'Ana Ruiz', role: 'ASSISTANT' },
    ];
    const asReception = await ctx.options.execute('p1', RECEPTION);
    expect(asReception.professionals.map((p) => p.id)).toEqual([
      'dentist-1',
      'assistant-1',
    ]);
    expect(asReception.professionals[0]).toMatchObject({ role: 'DENTIST' });
    expect(asReception.defaultProfessionalId).toBeNull();
    // Un clínico que ya no es miembro vivo (no está en la lista) no queda por defecto.
    expect(
      (await ctx.options.execute('p1', { userId: 'gone-1', clinical: true }))
        .defaultProfessionalId,
    ).toBeNull();
    expect(
      (await ctx.options.execute('p1', DENTIST)).defaultProfessionalId,
    ).toBe('dentist-1');
  });

  it('enviar con un profesional no elegible es 400 en español y no crea nada', async () => {
    const ctx = setup();
    await expect(
      send(ctx, DENTIST, { professionalId: 'reception-1' }),
    ).rejects.toThrow(
      new BadRequestException(SIGNATURE_PROFESSIONAL_INVALID_MESSAGE),
    );
    // Un clínico que ya no está en la clínica tampoco se usa por defecto.
    await expect(
      send(ctx, { userId: 'gone-1', clinical: true }),
    ).rejects.toThrow(SIGNATURE_PROFESSIONAL_INVALID_MESSAGE);
    expect(ctx.repo.rows).toHaveLength(0);
  });

  it('ofrece los planes vivos del paciente (sin cancelados) a cualquier rol que envía, y si la plantilla usa {{tratamiento}}', async () => {
    const ctx = setup();
    ctx.repo.plans = [
      {
        id: 'plan-1',
        status: 'PRESENTED',
        optionLabel: 'Opción A: implante',
        createdAt: new Date('2026-10-20T15:00:00.000Z'),
      },
    ];
    const options = await ctx.options.execute('p1', RECEPTION);
    expect(options.plans).toEqual([
      {
        id: 'plan-1',
        status: 'PRESENTED',
        optionLabel: 'Opción A: implante',
        createdAt: new Date('2026-10-20T15:00:00.000Z'),
      },
    ]);
    expect(options.templates[0]).toMatchObject({ usesTreatment: false });
  });

  it('dice cuándo el paciente ya completó cada plantilla (la última vez)', async () => {
    const ctx = setup();
    const signedAt = new Date('2026-10-01T16:00:00.000Z');
    ctx.repo.completed = [{ templateId: ctx.template.id, signedAt }];
    const options = await ctx.options.execute('p1', RECEPTION);
    expect(options.templates[0]).toMatchObject({
      id: ctx.template.id,
      lastCompletedAt: signedAt,
    });
  });

  it('recepción puede asociar un plan del paciente; uno de otro paciente es 404', async () => {
    const ctx = setup();
    ctx.consents.plans['plan-1'] = { patientId: 'p1', items: [] };
    await send(ctx, RECEPTION, {
      professionalId: 'dentist-1',
      treatmentPlanId: 'plan-1',
    });
    expect(ctx.repo.rows[0].treatmentPlanId).toBe('plan-1');
    await expect(
      send(ctx, RECEPTION, {
        professionalId: 'dentist-1',
        treatmentPlanId: 'plan-de-otro',
      }),
    ).rejects.toBeInstanceOf(NotFoundException);
  });
});

describe('enlace público, código y firma (DX-243)', () => {
  it('estado mínimo sin documento; pedir el código marca la apertura, lo audita y lo envía al destino', async () => {
    const ctx = setup();
    await send(ctx);
    const token = tokenOf(ctx);
    const view = await ctx.inTenant(() => ctx.view.execute(token));
    expect(view).toMatchObject({
      destinationMasked: 'an***@example.com',
      codeSent: false,
    });
    expect(JSON.stringify(view)).not.toMatch(/Ana|exodoncia/i);
    expect(ctx.repo.rows[0].openedAt).toBeNull();

    await ctx.inTenant(() => ctx.code.execute(token, EVIDENCE));
    expect(ctx.repo.rows[0].openedAt).toEqual(SENT_AT);
    expect(ctx.codes[0].to).toBe('ana.perez@example.com');
    expect(ctx.codes[0].vars.code).toMatch(/^\d{6}$/);
    expect(ctx.repo.rows[0].codeHash).not.toContain(ctx.codes[0].vars.code);
    expect(ctx.repo.audits.map((a) => a.reason)).toEqual([
      'SIGNATURE_LINK_OPENED',
      'SIGNATURE_CODE_SENT',
    ]);
  });

  it('reenviar exige 60 s y como mucho 5 envíos', async () => {
    const ctx = setup();
    await send(ctx);
    const token = tokenOf(ctx);
    await ctx.inTenant(() => ctx.code.execute(token, EVIDENCE));
    await expect(
      ctx.inTenant(() => ctx.code.execute(token, EVIDENCE)),
    ).rejects.toMatchObject({ status: 429 });
    for (let i = 0; i < 4; i++) {
      ctx.advance(61_000);
      await ctx.inTenant(() => ctx.code.execute(token, EVIDENCE));
    }
    ctx.advance(61_000);
    const error = await ctx
      .inTenant(() => ctx.code.execute(token, EVIDENCE))
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(HttpException);
    expect((error as HttpException).getStatus()).toBe(429);
    expect(ctx.codes).toHaveLength(5);
  });

  it('5 códigos incorrectos bloquean el enlace (aunque se pida otro) y la ficha lo ve', async () => {
    const ctx = setup();
    await send(ctx);
    const token = tokenOf(ctx);
    await ctx.inTenant(() => ctx.code.execute(token, EVIDENCE));
    const wrong = ctx.codes[0].vars.code === '000000' ? '111111' : '000000';
    for (const left of [4, 3]) {
      await expect(
        ctx.inTenant(() => ctx.verify.execute(token, wrong, EVIDENCE)),
      ).rejects.toMatchObject({
        response: { code: 'SIGNATURE_CODE_INVALID', attemptsLeft: left },
      });
    }
    ctx.advance(61_000);
    await ctx.inTenant(() => ctx.code.execute(token, EVIDENCE));
    const fresh = ctx.codes[1].vars.code === '000000' ? '111111' : '000000';
    for (const left of [2, 1]) {
      await expect(
        ctx.inTenant(() => ctx.verify.execute(token, fresh, EVIDENCE)),
      ).rejects.toMatchObject({ response: { attemptsLeft: left } });
    }
    await expect(
      ctx.inTenant(() => ctx.verify.execute(token, fresh, EVIDENCE)),
    ).rejects.toMatchObject({ response: { code: 'SIGNATURE_LINK_LOCKED' } });
    // Bloqueado: ni el código bueno ni la vista; misma respuesta que uno inventado.
    await expect(
      ctx.inTenant(() =>
        ctx.verify.execute(token, ctx.codes[1].vars.code, EVIDENCE),
      ),
    ).rejects.toThrow(new NotFoundException(SIGNATURE_LINK_INVALID_MESSAGE));
    await expect(ctx.inTenant(() => ctx.view.execute(token))).rejects.toThrow(
      SIGNATURE_LINK_INVALID_MESSAGE,
    );
    expect((await ctx.list.execute('p1'))[0]).toMatchObject({
      status: 'LOCKED',
      failedAttempts: 5,
    });
    expect(ctx.repo.audits.at(-1)?.reason).toBe('SIGNATURE_LINK_LOCKED');
  });

  it('el código caduca a los 10 minutos', async () => {
    const ctx = setup();
    await send(ctx);
    const token = tokenOf(ctx);
    await ctx.inTenant(() => ctx.code.execute(token, EVIDENCE));
    ctx.advance(10 * 60_000);
    await expect(
      ctx.inTenant(() =>
        ctx.verify.execute(token, ctx.codes[0].vars.code, EVIDENCE),
      ),
    ).rejects.toMatchObject({ response: { code: 'SIGNATURE_CODE_EXPIRED' } });
  });

  it('el documento solo se ve con la sesión del código verificado', async () => {
    const ctx = setup();
    const { token, session } = await verified(ctx);
    await expect(
      ctx.inTenant(() => ctx.document.execute(token, undefined)),
    ).rejects.toBeInstanceOf(ForbiddenException);
    await expect(
      ctx.inTenant(() =>
        ctx.document.execute(token, `${session.slice(0, -1)}x`),
      ),
    ).rejects.toBeInstanceOf(ForbiddenException);
    const doc = await ctx.inTenant(() => ctx.document.execute(token, session));
    expect(doc).toMatchObject({
      title: 'Consentimiento de exodoncia',
      body: 'Yo, Ana Pérez (Documento nacional 1020304050), autorizo a Dra. Laura Gómez.',
      signerName: 'Ana Pérez',
      signerDocumentRequired: false,
    });
    ctx.advance(30 * 60_000);
    await expect(
      ctx.inTenant(() => ctx.document.execute(token, session)),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('firmar guarda el consentimiento con hash y evidencias; el enlace queda usado y falta el profesional', async () => {
    const ctx = setup();
    const { token, session } = await verified(ctx);
    ctx.advance(5 * 60_000);
    const copy = await ctx.inTenant(() =>
      ctx.sign.execute(
        token,
        session,
        { signature: `data:image/png;base64,${PNG}`, accepted: true },
        EVIDENCE,
      ),
    );
    const [consent] = ctx.repo.consents;
    const row = ctx.repo.rows[0];
    expect(consent).toMatchObject({
      patientSignature: PNG,
      signerType: 'PATIENT',
      remoteChannel: 'EMAIL',
      remoteDestinationMasked: 'an***@example.com',
      remoteSentAt: SENT_AT,
      ipAddress: '203.0.113.7',
      userAgent: 'Mobile',
      signedAt: new Date('2026-10-30T14:05:00.000Z'),
    });
    expect(consent.contentHash).toBe(
      computeRemoteConsentHash({
        title: row.title,
        body: row.body,
        templateVersion: 1,
        signerType: 'PATIENT',
        signerName: 'Ana Pérez',
        signerDocument: 'Documento nacional 1020304050',
        professionalName: 'Dra. Laura Gómez',
        patientSignature: PNG,
        signedAt: consent.signedAt,
        channel: 'EMAIL',
        destinationMasked: 'an***@example.com',
        sentAt: SENT_AT,
        openedAt: row.openedAt!,
        verifiedAt: row.verifiedAt!,
        ipAddress: '203.0.113.7',
        userAgent: 'Mobile',
      }),
    );
    expect(copy.contentHash).toBe(consent.contentHash);
    expect((await ctx.list.execute('p1'))[0]).toMatchObject({
      status: 'SIGNED_BY_PATIENT',
      signedIpAddress: '203.0.113.7',
    });
    // Usado: la misma respuesta que un enlace inventado.
    await expect(
      ctx.inTenant(() =>
        ctx.sign.execute(
          token,
          session,
          { signature: PNG, accepted: true },
          EVIDENCE,
        ),
      ),
    ).rejects.toThrow(SIGNATURE_LINK_INVALID_MESSAGE);
    expect(ctx.repo.consents).toHaveLength(1);
  });

  it('sin confirmar la lectura, con una firma en blanco o sin el documento del responsable: 400 y nada se guarda', async () => {
    const ctx = setup();
    ctx.repo.recipients.p1 = recipient(
      { birthDate: new Date('2015-02-11T00:00:00.000Z') },
      [
        {
          id: 'r1',
          name: 'Claudia Navarro',
          email: 'claudia@example.com',
          isPayer: false,
          receivesNotices: true,
          optedOut: false,
          document: { docType: null, docTypeLabel: null, docNumber: null },
        },
      ],
    );
    const { token, session } = await verified(ctx);
    const doc = await ctx.inTenant(() => ctx.document.execute(token, session));
    expect(doc.signerDocumentRequired).toBe(true);
    for (const input of [
      { signature: PNG, accepted: false, signerDocument: 'C01' },
      { signature: PNG, accepted: true },
      { signature: 'no-es-png', accepted: true, signerDocument: 'C01' },
    ]) {
      await expect(
        ctx.inTenant(() => ctx.sign.execute(token, session, input, EVIDENCE)),
      ).rejects.toBeInstanceOf(BadRequestException);
    }
    expect(ctx.repo.consents).toHaveLength(0);
    await ctx.inTenant(() =>
      ctx.sign.execute(
        token,
        session,
        { signature: PNG, accepted: true, signerDocument: ' C01 ' },
        EVIDENCE,
      ),
    );
    expect(ctx.repo.consents[0]).toMatchObject({
      signerType: 'GUARDIAN',
      signerName: 'Claudia Navarro',
      signerDocument: 'C01',
    });
  });

  it('caducado (72 h), anulado o con un token inventado: «Enlace no válido» sin datos', async () => {
    const ctx = setup();
    const created = await send(ctx);
    const token = tokenOf(ctx);
    await expect(
      ctx.inTenant(() => ctx.view.execute('x'.repeat(43))),
    ).rejects.toThrow(SIGNATURE_LINK_INVALID_MESSAGE);
    // Sin clínica en el host.
    await expect(ctx.view.execute(token)).rejects.toThrow(
      SIGNATURE_LINK_INVALID_MESSAGE,
    );
    await ctx.revoke.execute('p1', created.id, 'reception-1');
    await expect(ctx.inTenant(() => ctx.view.execute(token))).rejects.toThrow(
      SIGNATURE_LINK_INVALID_MESSAGE,
    );
    await send(ctx);
    ctx.advance(72 * 60 * 60_000);
    await expect(
      ctx.inTenant(() => ctx.view.execute(tokenOf(ctx))),
    ).rejects.toThrow(SIGNATURE_LINK_INVALID_MESSAGE);
    expect((await ctx.list.execute('p1')).map((r) => r.status)).toEqual([
      'EXPIRED',
      'REVOKED',
    ]);
  });

  it('anular una ya firmada es 409; de otro paciente, 404', async () => {
    const ctx = setup();
    await verified(ctx);
    const id = ctx.repo.rows[0].id;
    await expect(ctx.revoke.execute('p2', id, 'r')).rejects.toBeInstanceOf(
      NotFoundException,
    );
    ctx.repo.rows[0].signedAt = SENT_AT;
    await expect(ctx.revoke.execute('p1', id, 'r')).rejects.toBeInstanceOf(
      ConflictException,
    );
  });
});

/** Un plan «Presentado» del paciente p1 con su presupuesto (DX-415). */
function presentedBudget(ctx: Ctx, planId = 'plan-1') {
  const budget = {
    quote: quoteSource({
      plan: {
        id: planId,
        patientId: 'p1',
        status: 'PRESENTED',
        currency: 'COP',
      },
    }),
    location: { id: 'loc-1', locale: 'es-CO', hourCycle: 'h12' },
  };
  ctx.repo.budgets.set(planId, budget);
  return budget;
}

async function sendBudget(ctx: Ctx, planId = 'plan-1') {
  return ctx.create.execute(
    'p1',
    { type: 'BUDGET', channel: 'EMAIL', treatmentPlanId: planId },
    RECEPTION,
    LINK,
  );
}

async function verifiedBudget(ctx: Ctx) {
  await sendBudget(ctx);
  const token = tokenOf(ctx);
  await ctx.inTenant(() => ctx.code.execute(token, EVIDENCE));
  const code = ctx.codes.at(-1)!.vars.code;
  const session = await ctx.inTenant(() =>
    ctx.verify.execute(token, code, EVIDENCE),
  );
  return { token, session: session.sessionToken };
}

describe('presupuesto a distancia (DX-415)', () => {
  it('congela la foto del presupuesto presentado y su hash; el email no lleva importes ni procedimientos', async () => {
    const ctx = setup();
    presentedBudget(ctx);
    const created = await sendBudget(ctx);
    const [row] = ctx.repo.rows;
    expect(row).toMatchObject({
      type: 'BUDGET',
      treatmentPlanId: 'plan-1',
      templateId: null,
      templateVersion: null,
      professionalUserId: 'reception-1',
      professionalName: 'Dra. Gómez',
    });
    const content = row.budgetContent as { issuedOn: string; items: unknown[] };
    expect(content.issuedOn).toBe('2026-10-30');
    expect(content.items).toHaveLength(2);
    expect(row.budgetContentHash).toBe(
      computeQuoteHash(row.budgetContent as never),
    );
    expect(created).toMatchObject({
      type: 'BUDGET',
      status: 'SENT',
      treatmentPlanId: 'plan-1',
      emailQueued: true,
    });
    expect(JSON.stringify(ctx.links[0].vars)).not.toMatch(
      /implante|resina|3500000|presupuesto/i,
    );
  });

  it('sin plan es 400; de otro paciente, 404; aceptado, rechazado o borrador, 409 en español; nada se crea', async () => {
    const ctx = setup();
    await expect(
      ctx.create.execute(
        'p1',
        { type: 'BUDGET', channel: 'EMAIL' },
        DENTIST,
        LINK,
      ),
    ).rejects.toThrow(
      new BadRequestException(SIGNATURE_BUDGET_PLAN_REQUIRED_MESSAGE),
    );
    await expect(sendBudget(ctx, 'plan-x')).rejects.toBeInstanceOf(
      NotFoundException,
    );
    const budget = presentedBudget(ctx);
    for (const [status, label] of [
      ['ACCEPTED', 'Aceptado'],
      ['REJECTED', 'Rechazado'],
      ['DRAFT', 'Borrador'],
    ] as const) {
      budget.quote = {
        ...budget.quote,
        plan: { ...budget.quote.plan, status },
      };
      await expect(sendBudget(ctx)).rejects.toThrow(
        new ConflictException(
          `Solo se envía a aceptar un presupuesto «Presentado»: este está «${label}».`,
        ),
      );
    }
    expect(ctx.repo.rows).toHaveLength(0);
  });

  it('enviarlo otra vez anula el enlace anterior del mismo plan', async () => {
    const ctx = setup();
    presentedBudget(ctx);
    await sendBudget(ctx);
    await sendBudget(ctx);
    expect(ctx.repo.rows[0].revokedAt).not.toBeNull();
    expect(ctx.cancelled).toEqual([ctx.repo.rows[0].id]);
  });

  it('tras verificar el código el paciente ve ítems, totales y condiciones del presupuesto enviado', async () => {
    const ctx = setup();
    presentedBudget(ctx);
    const { token, session } = await verifiedBudget(ctx);
    const doc = await ctx.inTenant(() => ctx.document.execute(token, session));
    expect(doc.type).toBe('BUDGET');
    expect(doc.body).toMatch(/Al firmar aceptas este presupuesto/);
    expect(doc.signerDocumentRequired).toBe(false);
    expect(doc.budget).toMatchObject({
      currency: 'COP',
      issuedOn: '2026-10-30',
      validUntil: '2026-11-29',
      totals: [{ gross: 3680000, discount: 350000, net: 3330000 }],
    });
    expect(doc.budget?.items[0]).toEqual(
      expect.objectContaining({ procedure: 'Implante', subtotal: 3150000 }),
    );
    expect(doc.budget?.items[0]).not.toHaveProperty('id');
  });

  it('si el plan cambia tras el envío (precio, ítem o estado), el enlace es «Enlace no válido»', async () => {
    for (const change of [
      (q: ReturnType<typeof presentedBudget>['quote']) => ({
        ...q,
        items: q.items.map((i, n) => (n === 0 ? { ...i, price: 3600000 } : i)),
      }),
      (q: ReturnType<typeof presentedBudget>['quote']) => ({
        ...q,
        items: q.items.slice(1),
      }),
      (q: ReturnType<typeof presentedBudget>['quote']) => ({
        ...q,
        plan: { ...q.plan, status: 'CANCELLED' as const },
      }),
    ]) {
      const ctx = setup();
      const budget = presentedBudget(ctx);
      const { token, session } = await verifiedBudget(ctx);
      budget.quote = change(budget.quote);
      await expect(ctx.inTenant(() => ctx.view.execute(token))).rejects.toThrow(
        new NotFoundException(SIGNATURE_LINK_INVALID_MESSAGE),
      );
      await expect(
        ctx.inTenant(() => ctx.document.execute(token, session)),
      ).rejects.toThrow(SIGNATURE_LINK_INVALID_MESSAGE);
    }
  });

  it('el día siguiente el mismo presupuesto sigue valiendo (la emisión es la de la foto)', async () => {
    const ctx = setup();
    presentedBudget(ctx);
    const { token } = await verifiedBudget(ctx);
    ctx.advance(30 * 3600_000);
    await expect(
      ctx.inTenant(() => ctx.view.execute(token)),
    ).resolves.toMatchObject({ type: 'BUDGET' });
  });

  it('al firmar registra la aceptación con evidencias, el plan pasa a ACCEPTED, la ficha lo ve completo y llega la confirmación', async () => {
    const ctx = setup();
    const budget = presentedBudget(ctx);
    const { token, session } = await verifiedBudget(ctx);
    ctx.advance(60_000);
    const copy = await ctx.inTenant(() =>
      ctx.sign.execute(
        token,
        session,
        { signature: PNG, accepted: true },
        EVIDENCE,
      ),
    );
    const [row] = ctx.repo.rows;
    expect(ctx.repo.acceptances).toHaveLength(1);
    const [acceptance] = ctx.repo.acceptances;
    expect(acceptance).toMatchObject({
      planId: 'plan-1',
      signatureRequestId: row.id,
      signerName: 'Ana Pérez',
      contentHash: row.budgetContentHash,
      acceptedById: 'reception-1',
      ipAddress: '203.0.113.7',
      userAgent: 'Mobile',
      remoteChannel: 'EMAIL',
      remoteDestinationMasked: 'an***@example.com',
      remoteSentAt: SENT_AT,
      remoteOpenedAt: SENT_AT,
      remoteVerifiedAt: SENT_AT,
    });
    expect(acceptance.content).toEqual(row.budgetContent);
    expect(copy.contentHash).toBe(acceptance.acceptanceHash);
    expect(budget.quote.plan.status).toBe('ACCEPTED');
    expect(ctx.repo.consents).toHaveLength(0);
    const [summary] = await ctx.list.execute('p1');
    expect(summary).toMatchObject({
      status: 'COMPLETE',
      budgetAcceptanceId: acceptance.id,
      signedIpAddress: '203.0.113.7',
    });
    expect(ctx.confirmations).toHaveLength(1);
    expect(ctx.confirmations[0].to).toBe('ana.perez@example.com');
    expect(JSON.stringify(ctx.confirmations[0].vars)).not.toMatch(
      /implante|resina|3330000/i,
    );
    // El enlace ya está usado.
    await expect(ctx.inTenant(() => ctx.view.execute(token))).rejects.toThrow(
      SIGNATURE_LINK_INVALID_MESSAGE,
    );
  });

  it('si el plan cambia entre ver y firmar, no se acepta nada', async () => {
    const ctx = setup();
    const budget = presentedBudget(ctx);
    const { token, session } = await verifiedBudget(ctx);
    const sign = ctx.inTenant(() =>
      ctx.sign.execute(
        token,
        session,
        { signature: PNG, accepted: true },
        EVIDENCE,
      ),
    );
    budget.quote = {
      ...budget.quote,
      items: budget.quote.items.map((i) => ({ ...i, discount: 0 })),
    };
    await expect(sign).rejects.toThrow(SIGNATURE_LINK_INVALID_MESSAGE);
    expect(ctx.repo.acceptances).toHaveLength(0);
    expect(ctx.repo.rows[0].signedAt).toBeNull();
    expect(ctx.confirmations).toHaveLength(0);
  });
});

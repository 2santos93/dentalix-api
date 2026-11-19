import { INestApplication } from '@nestjs/common';
import { ClinicRole, Prisma, PrismaClient } from '@prisma/client';
import request from 'supertest';
import { App } from 'supertest/types';
import {
  MESSAGE_TEMPLATE_LANGUAGE_MESSAGE,
  MESSAGE_TEMPLATE_NOT_FOUND_MESSAGE,
  MESSAGE_TEMPLATE_NOT_VERIFIED_MESSAGE,
  MESSAGE_TEMPLATE_TEST_WHATSAPP_MESSAGE,
} from '../src/modules/message-templates/application/message-templates.use-cases';
import {
  MESSAGE_EMAIL_LINKS_MESSAGE,
  MESSAGE_WHATSAPP_SUBJECT_MESSAGE,
} from '../src/modules/message-templates/domain/message-template-engine';
import { defaultMessageText } from '../src/modules/message-templates/domain/message-catalog';
import { MESSAGE_TEMPLATES_FORBIDDEN_MESSAGE } from '../src/modules/message-templates/presentation/message-templates.controller';
import { EmailDispatcher } from '../src/modules/notifications/email/application/email-dispatcher.service';
import { MAILER } from '../src/modules/notifications/email/domain/ports/mailer.port';
import { CapturingMailer } from './support/capture-mailer';
import {
  Clinic,
  createE2eApp,
  loginAs,
  registerClinic,
  resetDatabase,
  seedMember,
} from './support/e2e-fixtures';

// DX-565 por HTTP contra Postgres: Ajustes › Mensajes. Solo ADMIN; 400 en
// español con el campo; guardar, restablecer y probar auditados
// (CLINIC_SETTINGS, sin sede, el cuerpo oculto); vista previa sin escribir
// nada; la prueba llega solo a quien la pide con «[Prueba]» (una cada 5 min);
// y cada clínica ve y cambia solo sus textos.
const raw = new PrismaClient<Prisma.PrismaClientOptions>({
  datasources: { db: { url: process.env.DIRECT_URL } },
});

const REMINDER = '/api/v1/message-templates/appointment-reminder/EMAIL/es';
const CONFIRMATION_WA =
  '/api/v1/message-templates/appointment-confirmation/WHATSAPP/es';

interface LanguageView {
  language: string;
  offered: boolean;
  default: { subject: string | null; body: string };
  custom: {
    subject: string | null;
    body: string;
    updatedByName: string | null;
  } | null;
}
interface CatalogBody {
  languages: string[];
  messages: {
    key: string;
    channels: {
      channel: string;
      variables: { name: string }[];
      required: string[];
      languages: LanguageView[];
    }[];
  }[];
}

describe('Ajustes › Mensajes (e2e, DX-565)', () => {
  const mailer = new CapturingMailer();
  let app: INestApplication<App>;
  let clinic: Clinic;
  let other: Clinic;
  let locationId: string;
  let dentist: string;
  let reception: string;
  let assistant: string;

  const api = () => request(app.getHttpServer());
  const as = (req: request.Test, token = clinic.adminToken, c = clinic) => {
    const r = req
      .set('X-Tenant-Host', c.host)
      .set('Authorization', `Bearer ${token}`);
    // En A, la sede activa viaja en la petición; el evento no debe llevarla.
    return c === clinic ? r.set('X-Location-Id', locationId) : r;
  };
  const ownerEmail = () => `owner@${clinic.subdomain}.test`;

  const events = async (tenantId = clinic.tenantId) =>
    (
      await raw.auditEvent.findMany({
        where: { tenantId, resourceType: 'CLINIC_SETTINGS' },
        orderBy: { occurredAt: 'asc' },
      })
    ).filter((e) =>
      String((e.metadata as { reason?: string }).reason).startsWith(
        'MESSAGE_TEMPLATE_',
      ),
    );

  const channelOf = (body: CatalogBody, key: string, channel: string) =>
    body.messages
      .find((m) => m.key === key)!
      .channels.find((c) => c.channel === channel)!;

  beforeAll(async () => {
    app = await createE2eApp((b) =>
      b.overrideProvider(MAILER).useValue(mailer),
    );
    await resetDatabase(raw);
    clinic = await registerClinic(app, 'dx565-e2e');
    other = await registerClinic(app, 'dx565-e2e-otra');
    locationId = (
      await raw.location.findFirstOrThrow({
        where: { tenantId: clinic.tenantId },
        select: { id: true },
      })
    ).id;
    const token = async (role: ClinicRole) =>
      loginAs(app, clinic.host, (await seedMember(raw, clinic, role)).email);
    dentist = await token(ClinicRole.DENTIST);
    reception = await token(ClinicRole.RECEPTION);
    assistant = await token(ClinicRole.ASSISTANT);
  });

  afterAll(async () => {
    await app.close();
    await raw.$disconnect();
  });

  it('solo ADMIN: el resto recibe 403 en español en las cinco rutas y nada se escribe', async () => {
    for (const token of [dentist, reception, assistant]) {
      for (const res of [
        await as(api().get('/api/v1/message-templates'), token),
        await as(api().put(REMINDER), token).send({ subject: 'x', body: 'y' }),
        await as(api().delete(REMINDER), token),
        await as(api().post(`${REMINDER}/preview`), token).send({
          subject: 'x',
          body: 'y',
        }),
        await as(api().post(`${REMINDER}/test`), token).send({}),
      ]) {
        expect(res.status).toBe(403);
        expect((res.body as { message: string }).message).toBe(
          MESSAGE_TEMPLATES_FORBIDDEN_MESSAGE,
        );
      }
    }
    expect(await raw.messageTemplate.count()).toBe(0);
    expect(await events()).toHaveLength(0);
  });

  it('el catálogo: 6 mensajes con sus canales, variables y textos por defecto; solo español mientras la clínica no ofrezca inglés', async () => {
    const res = await as(api().get('/api/v1/message-templates')).expect(200);
    const body = res.body as CatalogBody;
    expect(body.languages).toEqual(['es']);
    expect(body.messages.map((m) => m.key)).toEqual([
      'appointment-reminder',
      'appointment-confirmation',
      'slot-offer',
      'quote-follow-up',
      'appointment-series',
      'signature-request',
    ]);
    const reminder = channelOf(body, 'appointment-reminder', 'EMAIL');
    expect(reminder.variables.map((v) => v.name)).toEqual([
      'paciente',
      'clinica',
      'sede',
      'direccion',
      'fecha',
      'hora',
      'profesional',
    ]);
    expect(reminder.languages).toEqual([
      {
        language: 'es',
        offered: true,
        default: defaultMessageText('appointment-reminder', 'EMAIL', 'es'),
        custom: null,
      },
    ]);
    expect(
      channelOf(body, 'appointment-confirmation', 'WHATSAPP').required,
    ).toEqual(['enlace']);
    // Inglés: aún no ofrecido → 400 al escribirlo.
    const en = await as(
      api().put('/api/v1/message-templates/appointment-reminder/EMAIL/en'),
    )
      .send({ subject: 'Hi', body: 'Hello' })
      .expect(400);
    expect((en.body as { message: string }).message).toBe(
      MESSAGE_TEMPLATE_LANGUAGE_MESSAGE,
    );
    await raw.tenant.update({
      where: { id: clinic.tenantId },
      data: { patientLanguages: ['es', 'en-US'] },
    });
    const after = (await as(api().get('/api/v1/message-templates')).expect(200))
      .body as CatalogBody;
    expect(after.languages).toEqual(['es', 'en']);
    expect(
      channelOf(after, 'appointment-reminder', 'EMAIL').languages.map(
        (l) => l.language,
      ),
    ).toEqual(['es', 'en']);
    // La oferta de hueco solo tiene texto en español.
    expect(
      channelOf(after, 'slot-offer', 'WHATSAPP').languages.map(
        (l) => l.language,
      ),
    ).toEqual(['es']);
  });

  it('404 si el mensaje no existe o no va por ese canal; 400 si el idioma no tiene texto', async () => {
    for (const path of [
      '/api/v1/message-templates/payment-receipt/EMAIL/es',
      '/api/v1/message-templates/appointment-reminder/WHATSAPP/es',
      '/api/v1/message-templates/appointment-reminder/SMS/es',
    ]) {
      const res = await as(api().put(path))
        .send({ subject: 'x', body: 'y' })
        .expect(404);
      expect((res.body as { message: string }).message).toBe(
        MESSAGE_TEMPLATE_NOT_FOUND_MESSAGE,
      );
    }
    await as(api().put('/api/v1/message-templates/slot-offer/WHATSAPP/en'))
      .send({ body: 'Hi {enlace}' })
      .expect(400);
    await as(
      api().put('/api/v1/message-templates/appointment-reminder/EMAIL/fr'),
    )
      .send({ subject: 'x', body: 'y' })
      .expect(400);
  });

  it('400 en español con el campo: variable desconocida, importes, {enlace}, enlaces, asunto en WhatsApp y topes', async () => {
    const bad = async (
      path: string,
      body: object,
      field: string,
      message: string,
    ) => {
      const res = await as(api().put(path)).send(body).expect(400);
      expect(res.body).toMatchObject({
        statusCode: 400,
        code: 'MESSAGE_TEMPLATE_INVALID',
        field,
        message,
      });
    };
    await bad(
      REMINDER,
      { subject: 'Hola', body: 'Hola {nombre}' },
      'body',
      'La variable {nombre} no existe.',
    );
    await bad(
      REMINDER,
      { subject: 'Hola', body: 'Debes {importe}' },
      'body',
      '{importe} no se puede usar en el recordatorio: los mensajes al paciente no llevan importes ni datos clínicos.',
    );
    await bad(
      REMINDER,
      { subject: 'Hola {fecha}', body: 'Entra en www.ejemplo.com' },
      'body',
      MESSAGE_EMAIL_LINKS_MESSAGE,
    );
    await bad(
      REMINDER,
      { subject: 'a'.repeat(151), body: 'Hola' },
      'subject',
      'El asunto no puede pasar de 150 caracteres.',
    );
    await bad(
      CONFIRMATION_WA,
      { body: 'Hola {paciente}' },
      'body',
      'La confirmación por WhatsApp tiene que llevar {enlace}.',
    );
    await bad(
      CONFIRMATION_WA,
      { subject: 'Asunto', body: '{enlace}' },
      'subject',
      MESSAGE_WHATSAPP_SUBJECT_MESSAGE,
    );
    await bad(
      CONFIRMATION_WA,
      { body: `${'x'.repeat(1000)} {enlace}` },
      'body',
      'El texto no puede pasar de 1000 caracteres.',
    );
    expect(await raw.messageTemplate.count()).toBe(0);
    expect(await events()).toHaveLength(0);
  });

  it('la vista previa renderiza el borrador con datos de ejemplo y no escribe nada', async () => {
    const email = await as(api().post(`${REMINDER}/preview`))
      .send({
        subject: 'Tu cita en {clinica}',
        body: 'Hola {paciente} & cía, te esperamos el {fecha}[ con {profesional}].',
      })
      .expect(200);
    expect(email.body).toMatchObject({
      channel: 'EMAIL',
      subject: `Tu cita en Clinica ${clinic.subdomain}`,
    });
    const html = (email.body as { html: string }).html;
    expect(html).toContain(
      'Hola Ana &amp; cía, te esperamos el martes 20 de octubre de 2026 con Dra. Laura Gómez.',
    );
    // El resto del email, fijo (botón de confirmar).
    expect(html).toContain('Confirmar o cancelar');
    const wa = await as(api().post(`${CONFIRMATION_WA}/preview`))
      .send({ body: 'Hola {paciente}: {enlace}' })
      .expect(200);
    expect(wa.body).toEqual({
      channel: 'WHATSAPP',
      subject: null,
      html: null,
      text: 'Hola Ana: https://ejemplo.dentalix.app/vista-previa',
    });
    await as(api().post(`${REMINDER}/preview`))
      .send({ subject: 'x', body: 'Hola {nombre}' })
      .expect(400);
    expect(await raw.messageTemplate.count()).toBe(0);
    expect(await events()).toHaveLength(0);
  });

  // ISOLATION_COVERS: PUT /message-templates/:key/:channel/:language
  it('guardar: crea (CREATE) y cambia (UPDATE) con el asunto visible y el cuerpo oculto (longitud y huella); sin cambios no hay evento; B no ve ni toca el de A', async () => {
    const saved = await as(api().put(REMINDER))
      .send({
        subject: '  Tu cita en {clinica}  ',
        body: 'Hola {paciente}\r\n\r\n\r\nTe esperamos el {fecha} a las {hora}.',
      })
      .expect(200);
    expect(saved.body).toMatchObject({
      key: 'appointment-reminder',
      channel: 'EMAIL',
      language: 'es',
      offered: true,
      custom: {
        subject: 'Tu cita en {clinica}',
        body: 'Hola {paciente}\n\nTe esperamos el {fecha} a las {hora}.',
        updatedByName: expect.any(String) as string,
      },
    });
    const [created] = await events();
    expect(created).toMatchObject({
      action: 'CREATE',
      actorUserId: clinic.adminUserId,
      locationId: null,
    });
    const meta = created.metadata as {
      reason: string;
      configChange: { after: Record<string, unknown> };
    };
    expect(meta.reason).toBe('MESSAGE_TEMPLATE_UPDATED');
    expect(meta.configChange.after).toMatchObject({
      messageKey: 'appointment-reminder',
      channel: 'EMAIL',
      language: 'es',
      subject: 'Tu cita en {clinica}',
      bodyLength: 54,
      bodyHash: expect.stringMatching(/^[0-9a-f]{64}$/) as string,
    });
    expect(JSON.stringify(created.metadata)).not.toContain('Te esperamos');

    // Lo mismo otra vez: ni fila nueva ni evento.
    await as(api().put(REMINDER))
      .send({
        subject: 'Tu cita en {clinica}',
        body: 'Hola {paciente}\n\nTe esperamos el {fecha} a las {hora}.',
      })
      .expect(200);
    expect(await events()).toHaveLength(1);

    await as(api().put(REMINDER))
      .send({ subject: 'Tu cita en {clinica}', body: 'Hola {paciente}.' })
      .expect(200);
    const updated = (await events())[1];
    expect(updated.action).toBe('UPDATE');
    expect(updated.metadata).toMatchObject({
      reason: 'MESSAGE_TEMPLATE_UPDATED',
      changedFields: ['body', 'bodyHash', 'bodyLength'],
      configChange: {
        before: { bodyLength: 54 },
        after: { bodyLength: 16 },
      },
    });
    expect(JSON.stringify(updated.metadata)).not.toContain('Hola {paciente}');

    // B: su catálogo sale por defecto; su PUT crea SU fila y no toca la de A.
    const bCatalog = (
      await as(
        api().get('/api/v1/message-templates'),
        other.adminToken,
        other,
      ).expect(200)
    ).body as CatalogBody;
    expect(
      channelOf(bCatalog, 'appointment-reminder', 'EMAIL').languages[0].custom,
    ).toBeNull();
    await as(api().put(REMINDER), other.adminToken, other)
      .send({ subject: 'De B', body: 'Texto de B' })
      .expect(200);
    const rows = await raw.messageTemplate.findMany({
      where: { key: 'appointment-reminder' },
      select: { tenantId: true, subject: true, body: true },
    });
    expect(rows).toHaveLength(2);
    expect(rows.find((r) => r.tenantId === clinic.tenantId)).toEqual({
      tenantId: clinic.tenantId,
      subject: 'Tu cita en {clinica}',
      body: 'Hola {paciente}.',
    });
    expect(await events(other.tenantId)).toHaveLength(1);
  });

  // ISOLATION_COVERS: POST /message-templates/:key/:channel/:language/test
  it('enviarme una prueba: llega solo a quien la pide con «[Prueba]» y el borrador, auditada; otra antes de 5 min es 429; WhatsApp no; B no recibe el texto de A', async () => {
    const res = await as(api().post(`${REMINDER}/test`))
      .send({
        subject: 'Prueba de {clinica}',
        body: 'Borrador para {paciente}.',
      })
      .expect(200);
    expect(res.body).toEqual({ sentTo: 'ow***@dx565-e2e.test' });
    await app.get(EmailDispatcher).whenIdle();
    await mailer.waitFor(ownerEmail(), /Borrador para Ana\./);
    const email = mailer.sent.find(
      (m) => m.to === ownerEmail() && m.text.includes('Borrador para Ana.'),
    )!;
    expect(email.subject).toBe(
      `[Prueba] Prueba de Clinica ${clinic.subdomain}`,
    );
    expect(email.html).not.toContain('Dejar de recibir');
    const tests = (await events()).filter(
      (e) =>
        (e.metadata as { reason: string }).reason ===
        'MESSAGE_TEMPLATE_TEST_SENT',
    );
    expect(tests).toHaveLength(1);
    expect(tests[0]).toMatchObject({
      action: 'VIEW',
      actorUserId: clinic.adminUserId,
      locationId: null,
    });

    const again = await as(api().post(`${REMINDER}/test`))
      .send({})
      .expect(429);
    expect(again.body).toMatchObject({
      statusCode: 429,
      retryAfterSeconds: expect.any(Number) as number,
    });
    expect((again.body as { message: string }).message).toMatch(
      /^Ya te enviamos una prueba hace un momento\. Espera \d+ minutos? para pedir otra\.$/,
    );

    const wa = await as(api().post(`${CONFIRMATION_WA}/test`))
      .send({})
      .expect(400);
    expect((wa.body as { message: string }).message).toBe(
      MESSAGE_TEMPLATE_TEST_WHATSAPP_MESSAGE,
    );

    // B, sin cuerpo: su texto guardado («De B»), nunca el de A.
    await as(api().post(`${REMINDER}/test`), other.adminToken, other)
      .send({})
      .expect(200);
    await app.get(EmailDispatcher).whenIdle();
    await mailer.waitFor(`owner@${other.subdomain}.test`, /Texto de B/);
    const bEmail = mailer.sent.find(
      (m) =>
        m.to === `owner@${other.subdomain}.test` &&
        m.text.includes('Texto de B'),
    )!;
    expect(bEmail.subject).toBe('[Prueba] De B');
    expect(bEmail.text).not.toContain('Hola Ana.');
  });

  it('la prueba exige el correo confirmado (409 en español) y no sale nada', async () => {
    await raw.user.update({
      where: { id: other.adminUserId },
      data: { emailVerifiedAt: null },
    });
    const res = await as(
      api().post('/api/v1/message-templates/quote-follow-up/EMAIL/es/test'),
      other.adminToken,
      other,
    )
      .send({})
      .expect(409);
    expect(res.body).toMatchObject({
      code: 'EMAIL_NOT_VERIFIED',
      message: MESSAGE_TEMPLATE_NOT_VERIFIED_MESSAGE,
    });
  });

  // ISOLATION_COVERS: POST /message-templates/:key/:channel/:language/preview
  it('la vista previa de B no lee nada de A (borrador propio, marca propia)', async () => {
    const res = await as(
      api().post(`${REMINDER}/preview`),
      other.adminToken,
      other,
    )
      .send({ subject: 'Hola de {clinica}', body: 'Hola {paciente}' })
      .expect(200);
    expect((res.body as { subject: string }).subject).toBe(
      `Hola de Clinica ${other.subdomain}`,
    );
    expect((res.body as { html: string }).html).not.toMatch(
      new RegExp(`Clinica ${clinic.subdomain}(?!-otra)`),
    );
  });

  // ISOLATION_COVERS: DELETE /message-templates/:key/:channel/:language
  it('restablecer: borra la fila y lo audita con el antes; sin fila no hace nada; el de B no borra el de A', async () => {
    // B restablece el suyo: el de A sigue.
    await as(api().delete(REMINDER), other.adminToken, other).expect(200);
    expect(
      await raw.messageTemplate.count({ where: { tenantId: clinic.tenantId } }),
    ).toBe(1);

    const res = await as(api().delete(REMINDER)).expect(200);
    expect(res.body).toMatchObject({
      key: 'appointment-reminder',
      channel: 'EMAIL',
      language: 'es',
      custom: null,
      default: defaultMessageText('appointment-reminder', 'EMAIL', 'es'),
    });
    expect(
      await raw.messageTemplate.count({ where: { tenantId: clinic.tenantId } }),
    ).toBe(0);
    const reset = (await events()).filter(
      (e) =>
        (e.metadata as { reason: string }).reason === 'MESSAGE_TEMPLATE_RESET',
    );
    expect(reset).toHaveLength(1);
    expect(reset[0]).toMatchObject({ action: 'DELETE', locationId: null });
    expect(reset[0].metadata).toMatchObject({
      configChange: {
        before: {
          messageKey: 'appointment-reminder',
          subject: 'Tu cita en {clinica}',
          bodyLength: 16,
        },
      },
    });
    expect(JSON.stringify(reset[0].metadata)).not.toContain('Hola {paciente}');

    const count = (await events()).length;
    await as(api().delete(REMINDER)).expect(200);
    expect(await events()).toHaveLength(count);
  });

  it('restablecer vale para un idioma que la clínica ya retiró; guardarlo, no', async () => {
    const EN = '/api/v1/message-templates/appointment-reminder/EMAIL/en';
    await as(api().put(EN))
      .send({ subject: 'Your visit at {clinica}', body: 'Hello {paciente}.' })
      .expect(200);
    await raw.tenant.update({
      where: { id: clinic.tenantId },
      data: { patientLanguages: ['es'] },
    });
    const catalog = (
      await as(api().get('/api/v1/message-templates')).expect(200)
    ).body as CatalogBody;
    expect(
      channelOf(catalog, 'appointment-reminder', 'EMAIL').languages.map((l) => [
        l.language,
        l.offered,
        l.custom?.subject ?? null,
      ]),
    ).toEqual([
      ['es', true, null],
      ['en', false, 'Your visit at {clinica}'],
    ]);
    await as(api().put(EN))
      .send({ subject: 'Again', body: 'Hello.' })
      .expect(400);
    await as(api().delete(EN)).expect(200);
    expect(
      await raw.messageTemplate.count({ where: { tenantId: clinic.tenantId } }),
    ).toBe(0);
  });
});

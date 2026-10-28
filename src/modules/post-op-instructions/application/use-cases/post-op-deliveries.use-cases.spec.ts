import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  HttpException,
  Logger,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import type { AuditEventDraft } from '../../../audit/domain/audit-event';
import type { RecordAuditEventUseCase } from '../../../audit/application/record-audit-event.use-case';
import type { AuditRequestContext } from '../../../audit/domain/audit-request-context';
import type { PatientRepository } from '../../../patients/domain/ports/patient-repository.port';
import { hashPostOpToken } from '../../domain/postop-token';
import { TenantContextService } from '../../../../shared/tenancy/tenant-context.service';
import { LOCATION_NOT_ALLOWED_MESSAGE } from '../../../../shared/tenancy/location-access';
import { InMemoryPostOpTemplateRepository } from '../__fixtures__/in-memory-post-op-templates';
import {
  APPOINTMENT_ID,
  appointmentContext,
  FakePostOpEmailSender,
  InMemoryPostOpDeliveryRepository,
  PATIENT_ID,
} from '../__fixtures__/in-memory-post-op-deliveries';
import {
  DeliverPostOpInstructionsUseCase,
  GetPatientPostOpDeliveryUseCase,
  GetPostOpSuggestionsUseCase,
  ListPatientPostOpDeliveriesUseCase,
  POSTOP_APPOINTMENT_NOT_FOUND_MESSAGE,
  POSTOP_DELIVERY_NOT_FOUND_MESSAGE,
  POSTOP_INVALID_HOST_MESSAGE,
  POSTOP_NO_EMAIL_MESSAGE,
  POSTOP_NO_WHATSAPP_MESSAGE,
  POSTOP_OPTED_OUT_MESSAGE,
  POSTOP_TEMPLATE_INACTIVE_MESSAGE,
} from './post-op-deliveries.use-cases';
import { POSTOP_TEMPLATE_NOT_FOUND_MESSAGE } from './post-op-templates.use-cases';

const NOW = new Date('2026-10-20T15:00:00.000Z');
const LINK = { protocol: 'https' as const, host: 'sonrisas.dentalix.app' };
const CTX: AuditRequestContext = {
  tenantId: 't1',
  locationId: null,
  actor: { userId: 'user-1', role: 'RECEPTION' },
  requestId: 'req-1',
  ip: '127.0.0.1',
  userAgent: 'jest',
};
const BODY =
  'Hola {{paciente}}. Te atendió {{profesional}} en {{clinica}} el {{fecha}}. Dudas: {{telefono_sede}}. Muerde la gasa.';

function setup() {
  const deliveries = new InMemoryPostOpDeliveryRepository();
  const templates = new InMemoryPostOpTemplateRepository();
  const email = new FakePostOpEmailSender();
  const audits: AuditEventDraft[] = [];
  const audit = {
    record: (draft: AuditEventDraft) => {
      audits.push(draft);
      return Promise.resolve();
    },
  } as unknown as RecordAuditEventUseCase;
  const patients = {
    findById: (id: string) =>
      Promise.resolve(id === PATIENT_ID ? { id } : null),
  } as unknown as PatientRepository;
  const clock = () => NOW;
  const tenantContext = new TenantContextService();
  deliveries.contexts.set(APPOINTMENT_ID, appointmentContext());
  const exo = templates.seed({
    code: 'POI-EXO',
    title: 'Exodoncia',
    body: BODY,
  });
  const deliver = new DeliverPostOpInstructionsUseCase(
    deliveries,
    templates,
    email,
    audit,
    clock,
    tenantContext,
  );
  const suggestions = new GetPostOpSuggestionsUseCase(
    deliveries,
    templates,
    clock,
    tenantContext,
  );
  const list = new ListPatientPostOpDeliveriesUseCase(deliveries, patients);
  const get = new GetPatientPostOpDeliveryUseCase(deliveries, patients);
  return {
    deliveries,
    templates,
    email,
    audits,
    exo,
    deliver,
    suggestions,
    list,
    get,
    tenantContext,
  };
}

/** El token del enlace, sacado de la URL pública (solo viaja ahí). */
function tokenOf(url: string | null): string {
  const match = /\/indicaciones\/([A-Za-z0-9_-]{43})$/.exec(url ?? '');
  if (!match) throw new Error(`URL sin token: ${url}`);
  return match[1];
}

describe('DeliverPostOpInstructionsUseCase (DX-222)', () => {
  it('PRINT: congela el texto con las variables, sin token ni destinatario, y lo audita', async () => {
    const { deliver, exo, deliveries, audits } = setup();
    const result = await deliver.execute(
      APPOINTMENT_ID,
      { templateId: exo.id, channel: 'PRINT' },
      CTX,
      LINK,
    );

    expect(result).toMatchObject({
      publicUrl: null,
      whatsapp: null,
      sentTo: null,
      sentToResponsible: false,
      emailQueued: false,
    });
    const [row] = deliveries.rows;
    expect(row).toMatchObject({
      patientId: PATIENT_ID,
      appointmentId: APPOINTMENT_ID,
      locationId: 'loc-1',
      templateId: exo.id,
      templateCode: 'POI-EXO',
      templateTitle: 'Exodoncia',
      templateVersion: 1,
      channel: 'PRINT',
      deliveredById: 'user-1',
      deliveredByName: 'Recepción Demo',
      recipientMasked: null,
      sentToResponsible: false,
      tokenHash: null,
      tokenExpiresAt: null,
    });
    // Fecha civil de la cita en la zona de la sede (en UTC ya es el 21).
    expect(row.renderedText).toBe(
      'Hola Carolina Duque. Te atendió Dra. Laura Gómez en Sonrisas del Norte el 20/10/2026. Dudas: 601 555 0101. Muerde la gasa.',
    );
    expect(result.delivery.id).toBe(row.id);
    expect(audits).toEqual([
      expect.objectContaining({
        tenantId: 't1',
        action: 'CREATE',
        resourceType: 'POSTOP_DELIVERY',
        resourceId: row.id,
        patient: { kind: 'postOpDelivery', id: row.id },
        actor: { kind: 'user', userId: 'user-1', role: 'RECEPTION' },
        metadata: { reason: 'PRINT' },
      }),
    ]);
  });

  it('una sede sin teléfono deja {{telefono_sede}} vacío', async () => {
    const { deliver, exo, deliveries } = setup();
    deliveries.contexts.set(
      APPOINTMENT_ID,
      appointmentContext({ location: { phone: null } }),
    );
    await deliver.execute(
      APPOINTMENT_ID,
      { templateId: exo.id, channel: 'PRINT' },
      CTX,
      LINK,
    );
    expect(deliveries.rows[0].renderedText).toContain('Dudas: . Muerde');
  });

  it('post-op fecha follows the location locale', async () => {
    const { deliver, exo, deliveries } = setup();
    deliveries.contexts.set(
      APPOINTMENT_ID,
      appointmentContext({
        location: {
          timeZone: 'America/New_York',
          locale: 'en-US',
          hourCycle: 'h12',
        },
      }),
    );
    await deliver.execute(
      APPOINTMENT_ID,
      { templateId: exo.id, channel: 'PRINT' },
      CTX,
      LINK,
    );
    // 02:30 UTC del 21 = 22:30 del 20 en Nueva York: mes primero en en-US.
    expect(deliveries.rows[0].renderedText).toContain('el 10/20/2026.');
  });

  it('una sede sin reloj: 409 LOCATION_LOCALE_REQUIRED sin registrar nada', async () => {
    const { deliver, exo, deliveries } = setup();
    deliveries.contexts.set(
      APPOINTMENT_ID,
      appointmentContext({ location: { hourCycle: null } }),
    );
    const error = await deliver
      .execute(
        APPOINTMENT_ID,
        { templateId: exo.id, channel: 'PRINT' },
        CTX,
        LINK,
      )
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ConflictException);
    expect((error as ConflictException).getResponse()).toMatchObject({
      code: 'LOCATION_LOCALE_REQUIRED',
      locationId: 'loc-1',
    });
    expect(deliveries.rows).toHaveLength(0);
  });

  it('una sede sin reloj entrega una plantilla sin {{fecha}} sin pedir el formato', async () => {
    const { deliver, templates, deliveries } = setup();
    deliveries.contexts.set(
      APPOINTMENT_ID,
      appointmentContext({ location: { locale: null, hourCycle: null } }),
    );
    const nodate = templates.seed({
      code: 'POI-SINFECHA',
      title: 'Sin fecha',
      body: 'Hola {{paciente}}. Muerde la gasa.',
    });
    await deliver.execute(
      APPOINTMENT_ID,
      { templateId: nodate.id, channel: 'PRINT' },
      CTX,
      LINK,
    );
    expect(deliveries.rows).toHaveLength(1);
    expect(deliveries.rows[0].renderedText).toBe(
      'Hola Carolina Duque. Muerde la gasa.',
    );
  });

  it('EMAIL a un adulto: token con caducidad a 30 días, solo su hash en la fila, y email sin el título ni el texto', async () => {
    const { deliver, exo, deliveries, email, audits } = setup();
    const result = await deliver.execute(
      APPOINTMENT_ID,
      { templateId: exo.id, channel: 'EMAIL' },
      CTX,
      LINK,
    );

    const token = tokenOf(result.publicUrl);
    expect(result.publicUrl).toBe(
      `https://sonrisas.dentalix.app/indicaciones/${token}`,
    );
    expect(result).toMatchObject({
      whatsapp: null,
      sentTo: 'ca***@example.com',
      sentToResponsible: false,
      emailQueued: true,
    });
    const [row] = deliveries.rows;
    expect(row.tokenHash).toBe(hashPostOpToken(token));
    expect(row.tokenExpiresAt).toEqual(new Date('2026-11-19T15:00:00.000Z'));
    expect(row.recipientMasked).toBe('ca***@example.com');
    expect(JSON.stringify(row)).not.toContain(token);
    expect(result.delivery.linkExpiresAt).toEqual(row.tokenExpiresAt);

    expect(email.checked).toEqual(['carolina.duque@example.com']);
    expect(email.sent).toEqual([
      {
        to: 'carolina.duque@example.com',
        referenceId: row.id,
        vars: {
          patientFirstName: 'Carolina',
          clinicName: 'Sonrisas del Norte',
          locationPhone: '601 555 0101',
          url: result.publicUrl,
          responsibleName: null,
        },
      },
    ]);
    expect(JSON.stringify(email.sent)).not.toMatch(/Exodoncia|gasa/);
    expect(audits[0].metadata).toEqual({ reason: 'EMAIL' });
  });

  it('EMAIL de un menor: va al responsable que recibe avisos y lo marca', async () => {
    const { deliver, exo, deliveries, email } = setup();
    deliveries.contexts.set(
      APPOINTMENT_ID,
      appointmentContext({
        patient: {
          firstName: 'Tomás',
          lastName: 'Ortiz',
          birthDate: new Date('2016-04-10T00:00:00.000Z'),
        },
        responsibles: [
          {
            id: 'resp-1',
            name: 'Claudia Navarro',
            email: 'claudia.navarro@example.com',
            isPayer: true,
            receivesNotices: true,
            optedOut: false,
          },
        ],
      }),
    );
    const result = await deliver.execute(
      APPOINTMENT_ID,
      { templateId: exo.id, channel: 'EMAIL' },
      CTX,
      LINK,
    );

    expect(result.sentTo).toBe('cl***@example.com');
    expect(result.sentToResponsible).toBe(true);
    expect(result.delivery.sentToResponsible).toBe(true);
    expect(deliveries.rows[0].sentToResponsible).toBe(true);
    expect(email.sent[0]).toMatchObject({
      to: 'claudia.navarro@example.com',
      vars: { patientFirstName: 'Tomás', responsibleName: 'Claudia' },
    });
  });

  it('post-op email recipient uses the clinic majorityAge', async () => {
    const { deliver, exo, deliveries, email } = setup();
    deliveries.contexts.set(
      APPOINTMENT_ID,
      appointmentContext({
        // 17 años el 2026-10-20, con email propio.
        patient: { birthDate: new Date('2009-03-01T00:00:00.000Z') },
        responsibles: [
          {
            id: 'resp-1',
            name: 'Claudia Navarro',
            email: 'claudia.navarro@example.com',
            isPayer: true,
            receivesNotices: true,
            optedOut: false,
          },
        ],
        majorityAge: 16,
      }),
    );
    const result = await deliver.execute(
      APPOINTMENT_ID,
      { templateId: exo.id, channel: 'EMAIL' },
      CTX,
      LINK,
    );

    expect(result.sentToResponsible).toBe(false);
    expect(email.sent[0]).toMatchObject({
      to: 'carolina.duque@example.com',
    });
  });

  it('EMAIL sin email ni responsable: 422 y no registra nada', async () => {
    const { deliver, exo, deliveries, email } = setup();
    deliveries.contexts.set(
      APPOINTMENT_ID,
      appointmentContext({ patient: { email: null } }),
    );
    const call = deliver.execute(
      APPOINTMENT_ID,
      { templateId: exo.id, channel: 'EMAIL' },
      CTX,
      LINK,
    );
    await expect(call).rejects.toThrow(UnprocessableEntityException);
    await expect(call).rejects.toThrow(POSTOP_NO_EMAIL_MESSAGE);
    expect(deliveries.rows).toEqual([]);
    expect(email.sent).toEqual([]);
  });

  it.each([
    ['EMAIL', { reminderOptOutAt: new Date('2026-09-01T00:00:00.000Z') }],
    ['EMAIL', { contactChannel: 'NONE' as const }],
    [
      'WHATSAPP_LINK',
      { reminderOptOutAt: new Date('2026-09-01T00:00:00.000Z') },
    ],
    ['WHATSAPP_LINK', { contactChannel: 'NONE' as const }],
  ] as const)(
    '%s con el paciente dado de baja (%o): 422 y no registra nada',
    async (channel, patient) => {
      const { deliver, exo, deliveries, email, audits } = setup();
      deliveries.contexts.set(APPOINTMENT_ID, appointmentContext({ patient }));
      const call = deliver.execute(
        APPOINTMENT_ID,
        { templateId: exo.id, channel },
        CTX,
        LINK,
      );
      await expect(call).rejects.toThrow(UnprocessableEntityException);
      await expect(call).rejects.toThrow(POSTOP_OPTED_OUT_MESSAGE);
      expect(deliveries.rows).toEqual([]);
      expect(email.sent).toEqual([]);
      expect(audits).toEqual([]);
    },
  );

  it('PRINT con el paciente dado de baja sí se registra (se entrega en mano)', async () => {
    const { deliver, exo, deliveries } = setup();
    deliveries.contexts.set(
      APPOINTMENT_ID,
      appointmentContext({ patient: { contactChannel: 'NONE' } }),
    );
    await deliver.execute(
      APPOINTMENT_ID,
      { templateId: exo.id, channel: 'PRINT' },
      CTX,
      LINK,
    );
    expect(deliveries.rows).toHaveLength(1);
  });

  it('EMAIL por encima del tope: propaga el 429 sin registrar la entrega', async () => {
    const { deliver, exo, deliveries, email } = setup();
    email.quotaError = new HttpException('Espera', 429);
    await expect(
      deliver.execute(
        APPOINTMENT_ID,
        { templateId: exo.id, channel: 'EMAIL' },
        CTX,
        LINK,
      ),
    ).rejects.toThrow('Espera');
    expect(deliveries.rows).toEqual([]);
    expect(email.sent).toEqual([]);
  });

  it('EMAIL con el outbox caído: la entrega queda registrada y auditada, 201 con el enlace y emailQueued false', async () => {
    const { deliver, exo, deliveries, email, audits } = setup();
    email.send = () => Promise.reject(new Error('outbox caído'));
    const warn = jest
      .spyOn(Logger.prototype, 'warn')
      .mockImplementation(() => undefined);
    const result = await deliver.execute(
      APPOINTMENT_ID,
      { templateId: exo.id, channel: 'EMAIL' },
      CTX,
      LINK,
    );

    expect(result.emailQueued).toBe(false);
    expect(result.sentTo).toBeNull();
    expect(result.publicUrl).toMatch(/\/indicaciones\//);
    expect(deliveries.rows).toHaveLength(1);
    expect(audits).toEqual([
      expect.objectContaining({
        action: 'CREATE',
        resourceId: deliveries.rows[0].id,
        metadata: { reason: 'EMAIL' },
      }),
    ]);
    // El log lleva solo el id de la entrega: ni la URL ni el destinatario.
    expect(warn).toHaveBeenCalledWith(
      expect.objectContaining({
        event: 'postop.email_not_enqueued',
        deliveryId: deliveries.rows[0].id,
      }),
    );
    const logged = JSON.stringify(warn.mock.calls);
    expect(logged).not.toContain(tokenOf(result.publicUrl));
    expect(logged).not.toContain('carolina.duque');
    warn.mockRestore();
  });

  it('un host inseguro no impide imprimir, pero EMAIL y WHATSAPP_LINK dan 400 sin registrar nada', async () => {
    const { deliver, exo, deliveries } = setup();
    const noHost = { protocol: 'https', host: null };
    for (const channel of ['EMAIL', 'WHATSAPP_LINK'] as const) {
      const call = deliver.execute(
        APPOINTMENT_ID,
        { templateId: exo.id, channel },
        CTX,
        noHost,
      );
      await expect(call).rejects.toThrow(BadRequestException);
      await expect(call).rejects.toThrow(POSTOP_INVALID_HOST_MESSAGE);
    }
    expect(deliveries.rows).toEqual([]);
    const printed = await deliver.execute(
      APPOINTMENT_ID,
      { templateId: exo.id, channel: 'PRINT' },
      CTX,
      noHost,
    );
    expect(printed.publicUrl).toBeNull();
    expect(deliveries.rows).toHaveLength(1);
  });

  it('WHATSAPP_LINK: número wa.me y texto con el enlace, sin el título ni el texto de la plantilla', async () => {
    const { deliver, exo, deliveries, email } = setup();
    const result = await deliver.execute(
      APPOINTMENT_ID,
      { templateId: exo.id, channel: 'WHATSAPP_LINK' },
      CTX,
      LINK,
    );

    const token = tokenOf(result.publicUrl);
    expect(result.whatsapp).toEqual({
      phone: '573101234567',
      text: `Hola Carolina, te saludamos de Sonrisas del Norte. Aquí tienes tus indicaciones de cuidado tras la visita: ${result.publicUrl}`,
    });
    expect(result.whatsapp?.text).not.toMatch(/Exodoncia|gasa/);
    expect(result.sentTo).toBeNull();
    expect(result.emailQueued).toBe(false);
    const [row] = deliveries.rows;
    expect(row.channel).toBe('WHATSAPP_LINK');
    expect(row.tokenHash).toBe(hashPostOpToken(token));
    expect(row.recipientMasked).toBe('********4567');
    expect(email.sent).toEqual([]);
  });

  it('WHATSAPP_LINK sin un teléfono utilizable: 422', async () => {
    const { deliver, exo, deliveries } = setup();
    deliveries.contexts.set(
      APPOINTMENT_ID,
      appointmentContext({ patient: { phone: null } }),
    );
    await expect(
      deliver.execute(
        APPOINTMENT_ID,
        { templateId: exo.id, channel: 'WHATSAPP_LINK' },
        CTX,
        LINK,
      ),
    ).rejects.toThrow(POSTOP_NO_WHATSAPP_MESSAGE);
    expect(deliveries.rows).toEqual([]);
  });

  it('el texto queda congelado con la versión de la plantilla: editarla no toca lo entregado', async () => {
    const { deliver, exo, deliveries, templates } = setup();
    await deliver.execute(
      APPOINTMENT_ID,
      { templateId: exo.id, channel: 'PRINT' },
      CTX,
      LINK,
    );
    await templates.update(exo.id, {
      body: 'Versión nueva para {{paciente}}.',
      bumpVersion: true,
    });
    await deliver.execute(
      APPOINTMENT_ID,
      { templateId: exo.id, channel: 'PRINT' },
      CTX,
      LINK,
    );

    const [v1, v2] = deliveries.rows;
    expect(v1.templateVersion).toBe(1);
    expect(v1.renderedText).toContain('Muerde la gasa.');
    expect(v2.templateVersion).toBe(2);
    expect(v2.renderedText).toBe('Versión nueva para Carolina Duque.');
  });

  it('cita de otra clínica o inexistente: 404', async () => {
    const { deliver, exo } = setup();
    const call = deliver.execute(
      'otra',
      { templateId: exo.id, channel: 'PRINT' },
      CTX,
      LINK,
    );
    await expect(call).rejects.toThrow(NotFoundException);
    await expect(call).rejects.toThrow(POSTOP_APPOINTMENT_NOT_FOUND_MESSAGE);
  });

  it('plantilla inexistente: 404; inactiva: 400', async () => {
    const { deliver, templates, deliveries } = setup();
    await expect(
      deliver.execute(
        APPOINTMENT_ID,
        { templateId: 'nada', channel: 'PRINT' },
        CTX,
        LINK,
      ),
    ).rejects.toThrow(POSTOP_TEMPLATE_NOT_FOUND_MESSAGE);
    const off = templates.seed({ code: 'POI-OFF', active: false });
    const call = deliver.execute(
      APPOINTMENT_ID,
      { templateId: off.id, channel: 'PRINT' },
      CTX,
      LINK,
    );
    await expect(call).rejects.toThrow(BadRequestException);
    await expect(call).rejects.toThrow(POSTOP_TEMPLATE_INACTIVE_MESSAGE);
    expect(deliveries.rows).toEqual([]);
  });
});

describe('GetPostOpSuggestionsUseCase (DX-222)', () => {
  function withTemplates() {
    const s = setup();
    // POI-EXO: por el tipo de la cita; POI-IMP: por un procedimiento hecho;
    // POI-BLA: sin vínculo que coincida; POI-OFF: inactiva, no sale.
    s.exo.links = [
      {
        id: 'l1',
        tenantId: 't1',
        templateId: s.exo.id,
        catalogItemId: null,
        appointmentTypeId: 'type-cx',
        createdAt: NOW,
      },
    ];
    const imp = s.templates.seed({ code: 'POI-IMP', title: 'Implante' });
    imp.links = [
      {
        id: 'l2',
        tenantId: 't1',
        templateId: imp.id,
        catalogItemId: 'cat-imp',
        appointmentTypeId: null,
        createdAt: NOW,
      },
    ];
    const bla = s.templates.seed({ code: 'POI-BLA', title: 'Blanqueamiento' });
    s.templates.seed({ code: 'POI-OFF', title: 'Apagada', active: false });
    s.deliveries.performed.set(APPOINTMENT_ID, ['cat-imp']);
    return { ...s, imp, bla };
  }

  it('separa sugeridas y resto, con el canal de email y de WhatsApp listos', async () => {
    const { suggestions, exo, imp, bla, deliveries } = withTemplates();
    const view = await suggestions.execute(APPOINTMENT_ID);

    expect(view.patientId).toBe(PATIENT_ID);
    expect(view.suggested.map((t) => t.id)).toEqual([exo.id, imp.id]);
    expect(view.others.map((t) => t.id)).toEqual([bla.id]);
    expect(view.suggested[0]).toEqual({
      id: exo.id,
      code: 'POI-EXO',
      title: 'Exodoncia',
      version: 1,
    });
    // Los ítems realizados se buscan en el día civil de la cita en la sede.
    expect(deliveries.performedQueries).toEqual([
      { day: '2026-10-20', timeZone: 'America/Bogota' },
    ]);
    expect(view.email).toEqual({
      allowed: true,
      reason: null,
      toMasked: 'ca***@example.com',
      toResponsible: false,
    });
    expect(view.whatsapp).toEqual({ phone: '573101234567', reason: null });
    expect(view.locationPhone).toBe('601 555 0101');
    expect(view.deliveries).toEqual([]);
  });

  it('sin vínculos que coincidan: todo en «otras»', async () => {
    const { suggestions, deliveries, exo } = setup();
    deliveries.contexts.set(
      APPOINTMENT_ID,
      appointmentContext({ appointment: { appointmentTypeId: null } }),
    );
    const view = await suggestions.execute(APPOINTMENT_ID);
    expect(view.suggested).toEqual([]);
    expect(view.others.map((t) => t.id)).toEqual([exo.id]);
  });

  it('las entregas de la cita salen las más recientes primero', async () => {
    const { suggestions, deliver, exo } = setup();
    const first = await deliver.execute(
      APPOINTMENT_ID,
      { templateId: exo.id, channel: 'PRINT' },
      CTX,
      LINK,
    );
    const second = await deliver.execute(
      APPOINTMENT_ID,
      { templateId: exo.id, channel: 'EMAIL' },
      CTX,
      LINK,
    );
    const view = await suggestions.execute(APPOINTMENT_ID);
    expect(view.deliveries.map((d) => d.id)).toEqual([
      second.delivery.id,
      first.delivery.id,
    ]);
  });

  it('paciente dado de baja: ni email ni WhatsApp, con el motivo', async () => {
    const { suggestions, deliveries } = setup();
    deliveries.contexts.set(
      APPOINTMENT_ID,
      appointmentContext({
        patient: { reminderOptOutAt: new Date('2026-09-01T00:00:00.000Z') },
      }),
    );
    const view = await suggestions.execute(APPOINTMENT_ID);
    expect(view.email).toEqual({
      allowed: false,
      reason: POSTOP_OPTED_OUT_MESSAGE,
      toMasked: null,
      toResponsible: false,
    });
    expect(view.whatsapp).toEqual({
      phone: null,
      reason: POSTOP_OPTED_OUT_MESSAGE,
    });
  });

  it('sin email ni teléfono: los dos canales lo explican', async () => {
    const { suggestions, deliveries } = setup();
    deliveries.contexts.set(
      APPOINTMENT_ID,
      appointmentContext({ patient: { email: null, phone: null } }),
    );
    const view = await suggestions.execute(APPOINTMENT_ID);
    expect(view.email).toMatchObject({
      allowed: false,
      reason: POSTOP_NO_EMAIL_MESSAGE,
    });
    expect(view.whatsapp).toEqual({
      phone: null,
      reason: POSTOP_NO_WHATSAPP_MESSAGE,
    });
  });

  it('cita de otra clínica: 404', async () => {
    const { suggestions } = setup();
    await expect(suggestions.execute('otra')).rejects.toThrow(
      POSTOP_APPOINTMENT_NOT_FOUND_MESSAGE,
    );
  });
});

describe('Historial de entregas del paciente (DX-222)', () => {
  it('lista las del paciente, las más recientes primero', async () => {
    const { deliver, exo, list } = setup();
    const a = await deliver.execute(
      APPOINTMENT_ID,
      { templateId: exo.id, channel: 'PRINT' },
      CTX,
      LINK,
    );
    const b = await deliver.execute(
      APPOINTMENT_ID,
      { templateId: exo.id, channel: 'PRINT' },
      CTX,
      LINK,
    );
    const rows = await list.execute(PATIENT_ID);
    expect(rows.map((r) => r.id)).toEqual([b.delivery.id, a.delivery.id]);
  });

  it('paciente de otra clínica: 404', async () => {
    const { list, get } = setup();
    await expect(list.execute('otro')).rejects.toThrow(NotFoundException);
    await expect(get.execute('otro', 'x')).rejects.toThrow(NotFoundException);
  });

  it('el documento trae el texto congelado, la clínica y la sede', async () => {
    const { deliver, exo, get } = setup();
    const { delivery } = await deliver.execute(
      APPOINTMENT_ID,
      { templateId: exo.id, channel: 'PRINT' },
      CTX,
      LINK,
    );
    const doc = await get.execute(PATIENT_ID, delivery.id);
    expect(doc).toMatchObject({
      id: delivery.id,
      clinic: { name: 'Sonrisas del Norte' },
      locationName: 'Sede Norte',
      locationPhone: '601 555 0101',
      patientName: 'Carolina Duque',
    });
    expect(doc.renderedText).toContain('Muerde la gasa.');
    await expect(get.execute(PATIENT_ID, 'nada')).rejects.toThrow(
      POSTOP_DELIVERY_NOT_FOUND_MESSAGE,
    );
  });
});

// SEC-045: la restricción por sedes de DX-089, como GET /appointments/:id.
// La cita de los fixtures es de `loc-1`.
describe('Indicaciones de una cita y sede permitida (SEC-045)', () => {
  const asMemberOf = <T>(
    tenantContext: TenantContextService,
    locationIds: string[],
    fn: () => Promise<T>,
  ) => tenantContext.run('t1', undefined, fn, locationIds);

  it('sugerencias de una cita de otra sede: 403', async () => {
    const { suggestions, tenantContext } = setup();
    const denied = asMemberOf(tenantContext, ['loc-2'], () =>
      suggestions.execute(APPOINTMENT_ID),
    );
    await expect(denied).rejects.toBeInstanceOf(ForbiddenException);
    await expect(denied).rejects.toThrow(LOCATION_NOT_ALLOWED_MESSAGE);
  });

  it('entrega por EMAIL en una cita de otra sede: 403 sin entrega, sin email y sin auditoría', async () => {
    const { deliver, exo, deliveries, email, audits, tenantContext } = setup();
    const denied = asMemberOf(tenantContext, ['loc-2'], () =>
      deliver.execute(
        APPOINTMENT_ID,
        { templateId: exo.id, channel: 'EMAIL' },
        CTX,
        LINK,
      ),
    );
    await expect(denied).rejects.toBeInstanceOf(ForbiddenException);
    expect(deliveries.rows).toHaveLength(0);
    expect(email.sent).toHaveLength(0);
    expect(audits).toHaveLength(0);
  });

  it('en una sede permitida, o sin restricción, nada cambia', async () => {
    const { deliver, suggestions, exo, deliveries, tenantContext } = setup();
    await expect(
      asMemberOf(tenantContext, ['loc-1'], () =>
        suggestions.execute(APPOINTMENT_ID),
      ),
    ).resolves.toMatchObject({ patientId: PATIENT_ID });
    await asMemberOf(tenantContext, ['loc-1'], () =>
      deliver.execute(
        APPOINTMENT_ID,
        { templateId: exo.id, channel: 'PRINT' },
        CTX,
        LINK,
      ),
    );
    await tenantContext.run('t1', () =>
      deliver.execute(
        APPOINTMENT_ID,
        { templateId: exo.id, channel: 'PRINT' },
        CTX,
        LINK,
      ),
    );
    expect(deliveries.rows).toHaveLength(2);
  });
});

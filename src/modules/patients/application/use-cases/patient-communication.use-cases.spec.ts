import { BadRequestException, NotFoundException } from '@nestjs/common';
import type { AuditEventDraft } from '../../../audit/domain/audit-event';
import type { AuditRequestContext } from '../../../audit/domain/audit-request-context';
import { FakePatientCommunicationRepository } from '../__fixtures__/fake-patient-communication.repository';
import {
  GetPatientCommunicationUseCase,
  UpdatePatientCommunicationUseCase,
  WHATSAPP_NEEDS_VALID_MOBILE,
} from './patient-communication.use-cases';

const TENANT = '9f3a1b2c-0000-4000-8000-0000000000aa';
const ANA = '5a1c7d2e-0000-4000-8000-000000000101';
const RECEPTION = '7b2d0000-0000-4000-8000-0000000000c1';
const NOW = new Date('2026-10-20T12:00:00.000Z');

const ctx: AuditRequestContext = {
  tenantId: TENANT,
  locationId: null,
  actor: { userId: RECEPTION, role: 'RECEPTION' },
  requestId: 'req-1',
  ip: '10.0.0.1',
  userAgent: 'jest',
};

describe('Bloque «Comunicaciones» de la ficha (DX-128)', () => {
  let repo: FakePatientCommunicationRepository;
  let audit: { record: jest.Mock };
  let update: UpdatePatientCommunicationUseCase;
  let get: GetPatientCommunicationUseCase;

  beforeEach(() => {
    repo = new FakePatientCommunicationRepository();
    repo.staff.set(RECEPTION, 'Rosa Recepción');
    audit = { record: jest.fn().mockResolvedValue(undefined) };
    const clock = () => NOW;
    update = new UpdatePatientCommunicationUseCase(repo, audit as never, clock);
    get = new GetPatientCommunicationUseCase(repo, clock);
  });

  const lastAudit = () =>
    (audit.record.mock.calls.at(-1) as [AuditEventDraft])[0];

  describe('lectura', () => {
    it('muestra el canal, el móvil validado en E.164 con el país de la sede y el canal de la clínica', async () => {
      repo.add(ANA, { phone: '310 123 4567' });
      await expect(get.execute(ANA)).resolves.toEqual({
        patientId: ANA,
        contactChannel: 'EMAIL',
        clinicDefaultChannel: 'EMAIL',
        phone: '310 123 4567',
        phoneE164: '+573101234567',
        phoneStatus: 'VALID',
        phoneCountry: 'CO',
        email: 'ana@example.com',
        whatsappOptIn: null,
        reminderOptOut: null,
        recipient: {
          kind: 'PATIENT',
          name: 'Ana',
          email: 'ana@example.com',
          minor: false,
          responsiblePartyId: null,
        },
      });
    });

    it('para un menor, los avisos van a su responsable (DX-203) o se saluda a su contacto principal', async () => {
      const mother = {
        id: 'r1',
        name: 'María José Pérez',
        email: 'maria@example.com',
        isPayer: true,
        receivesNotices: true,
        optedOut: false,
      };
      repo.add(ANA, {
        birthDate: new Date('2015-06-01'),
        responsibles: [mother],
      });
      await expect(get.execute(ANA)).resolves.toMatchObject({
        recipient: {
          kind: 'RESPONSIBLE',
          name: 'María',
          email: 'maria@example.com',
          minor: true,
          responsiblePartyId: 'r1',
        },
      });
      // En España, a los 16 ya recibe los suyos.
      repo.add(ANA, {
        birthDate: new Date('2009-06-01'),
        responsibles: [mother],
        noticeLocation: { country: 'ES', timeZone: 'Europe/Madrid' },
      });
      await expect(get.execute(ANA)).resolves.toMatchObject({
        recipient: { kind: 'PATIENT', minor: false },
      });
      repo.add(ANA, {
        birthDate: new Date('2015-06-01'),
        emergencyContactName: 'Luis Gómez',
      });
      await expect(get.execute(ANA)).resolves.toMatchObject({
        recipient: { kind: 'CONTACT', name: 'Luis', minor: true },
      });
    });

    it('sin sede, valida con el país del paciente', async () => {
      repo.country = null;
      repo.add(ANA, { phone: '612 34 56 78', countryCode: 'ES' });
      await expect(get.execute(ANA)).resolves.toMatchObject({
        phoneE164: '+34612345678',
        phoneCountry: 'ES',
      });
    });

    it('distingue sin móvil (MISSING) de un móvil inválido (INVALID)', async () => {
      repo.add(ANA);
      await expect(get.execute(ANA)).resolves.toMatchObject({
        phone: null,
        phoneStatus: 'MISSING',
        phoneE164: null,
      });
      repo.add(ANA, { phone: '601 234 5678' });
      await expect(get.execute(ANA)).resolves.toMatchObject({
        phoneStatus: 'INVALID',
        phoneE164: null,
      });
    });

    it('404 en español si el paciente no es de esta clínica', async () => {
      await expect(get.execute(ANA)).rejects.toThrow(
        new NotFoundException('Paciente no encontrado'),
      );
    });
  });

  describe('cambio de canal', () => {
    it('WHATSAPP con móvil válido: guarda el móvil normalizado y audita autor y origen', async () => {
      repo.add(ANA, { phone: '310 123 4567' });
      const view = await update.execute(
        ANA,
        { contactChannel: 'WHATSAPP' },
        ctx,
      );
      expect(view).toMatchObject({
        contactChannel: 'WHATSAPP',
        phone: '310 123 4567',
        phoneE164: '+573101234567',
      });
      expect(lastAudit()).toEqual({
        tenantId: TENANT,
        locationId: null,
        actor: { kind: 'user', userId: RECEPTION, role: 'RECEPTION' },
        action: 'UPDATE',
        resourceType: 'PATIENT',
        resourceId: ANA,
        patient: { kind: 'patient', id: ANA },
        requestId: 'req-1',
        ip: '10.0.0.1',
        userAgent: 'jest',
        metadata: {
          reason: 'COMMUNICATION_PREFERENCES_CHANGED',
          origin: 'STAFF',
          changedFields: ['contactChannel'],
        },
      });
    });

    it.each([
      ['sin móvil', null],
      ['con un fijo', '601 234 5678'],
      ['con texto', 'llamar a la mamá'],
    ])('WHATSAPP %s: 400 en español y no se guarda nada', async (_, phone) => {
      repo.add(ANA, { phone });
      const err = await update
        .execute(ANA, { contactChannel: 'WHATSAPP' }, ctx)
        .catch((e: unknown) => e);
      expect(err).toBeInstanceOf(BadRequestException);
      expect((err as BadRequestException).getResponse()).toMatchObject({
        code: 'WHATSAPP_REQUIRES_VALID_MOBILE',
        message: WHATSAPP_NEEDS_VALID_MOBILE,
      });
      expect(WHATSAPP_NEEDS_VALID_MOBILE).toMatch(/^Para elegir WhatsApp/);
      expect(repo.updates).toEqual([]);
      expect(audit.record).not.toHaveBeenCalled();
    });

    it('móvil y canal a la vez: valida el móvil NUEVO y lo guarda en E.164', async () => {
      repo.add(ANA, { phone: null });
      const view = await update.execute(
        ANA,
        { contactChannel: 'WHATSAPP', phone: ' 3101234567 ' },
        ctx,
      );
      expect(view).toMatchObject({
        contactChannel: 'WHATSAPP',
        phone: '+573101234567',
        phoneStatus: 'VALID',
      });
      expect(lastAudit().metadata.changedFields).toEqual([
        'contactChannel',
        'phone',
      ]);
    });

    it('cambiar a un móvil inválido con canal WHATSAPP: 400', async () => {
      repo.add(ANA, { phone: '+573101234567', contactChannel: 'WHATSAPP' });
      await expect(
        update.execute(ANA, { phone: '123' }, ctx),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('con canal EMAIL un móvil inválido se guarda tal cual (aviso, no error)', async () => {
      repo.add(ANA);
      const view = await update.execute(ANA, { phone: '601 234 5678' }, ctx);
      expect(view).toMatchObject({
        phone: '601 234 5678',
        phoneStatus: 'INVALID',
      });
    });

    it('vaciar el móvil (cadena vacía) lo deja en null', async () => {
      repo.add(ANA, { phone: '310 123 4567' });
      await expect(
        update.execute(ANA, { phone: '  ' }, ctx),
      ).resolves.toMatchObject({ phone: null, phoneStatus: 'MISSING' });
    });

    it('NONE no exige nada', async () => {
      repo.add(ANA, { email: null });
      await expect(
        update.execute(ANA, { contactChannel: 'NONE' }, ctx),
      ).resolves.toMatchObject({ contactChannel: 'NONE' });
    });

    it('sin cambios reales no escribe ni audita', async () => {
      repo.add(ANA, { phone: '+573101234567' });
      await update.execute(
        ANA,
        { contactChannel: 'EMAIL', phone: '+57 310 123 4567' },
        ctx,
      );
      expect(repo.updates).toEqual([]);
      expect(audit.record).not.toHaveBeenCalled();
    });

    it('404 si el paciente no es de esta clínica', async () => {
      await expect(
        update.execute(ANA, { contactChannel: 'NONE' }, ctx),
      ).rejects.toBeInstanceOf(NotFoundException);
    });
  });

  describe('opt-in de WhatsApp', () => {
    it('registra fecha, origen y autor, y el origen va a la auditoría', async () => {
      repo.add(ANA, { phone: '3101234567' });
      const view = await update.execute(
        ANA,
        { whatsappOptIn: true, whatsappOptInSource: 'IN_PERSON' },
        ctx,
      );
      expect(view.whatsappOptIn).toEqual({
        at: NOW,
        source: 'IN_PERSON',
        recordedBy: { id: RECEPTION, fullName: 'Rosa Recepción' },
      });
      expect(lastAudit().metadata).toEqual({
        reason: 'COMMUNICATION_PREFERENCES_CHANGED',
        origin: 'IN_PERSON',
        changedFields: ['whatsappOptIn'],
      });
    });

    it('exige el origen (400 en español)', async () => {
      repo.add(ANA, { phone: '3101234567' });
      await expect(
        update.execute(ANA, { whatsappOptIn: true }, ctx),
      ).rejects.toThrow(/dónde aceptó/);
    });

    it('exige un móvil válido', async () => {
      repo.add(ANA, { phone: '123' });
      await expect(
        update.execute(
          ANA,
          { whatsappOptIn: true, whatsappOptInSource: 'MESSAGE' },
          ctx,
        ),
      ).rejects.toThrow(WHATSAPP_NEEDS_VALID_MOBILE);
    });

    it('volver a marcarlo no cambia la fecha original', async () => {
      const before = new Date('2026-09-01T10:00:00.000Z');
      repo.add(ANA, {
        phone: '3101234567',
        whatsappOptInAt: before,
        whatsappOptInSource: 'LINK',
      });
      const view = await update.execute(
        ANA,
        { whatsappOptIn: true, whatsappOptInSource: 'IN_PERSON' },
        ctx,
      );
      expect(view.whatsappOptIn).toMatchObject({ at: before, source: 'LINK' });
      expect(audit.record).not.toHaveBeenCalled();
    });

    it('retirarlo borra fecha, origen y autor', async () => {
      repo.add(ANA, {
        phone: '3101234567',
        whatsappOptInAt: NOW,
        whatsappOptInSource: 'IN_PERSON',
        whatsappOptInBy: { id: RECEPTION, fullName: 'Rosa Recepción' },
      });
      const view = await update.execute(ANA, { whatsappOptIn: false }, ctx);
      expect(view.whatsappOptIn).toBeNull();
      expect(repo.updates.at(-1)).toEqual({
        whatsappOptInAt: null,
        whatsappOptInSource: null,
        whatsappOptInById: null,
      });
    });
  });

  describe('baja de recordatorios anotada por recepción', () => {
    it('registra la baja con origen STAFF', async () => {
      repo.add(ANA);
      const view = await update.execute(ANA, { reminderOptOut: true }, ctx);
      expect(view.reminderOptOut).toEqual({ at: NOW, source: 'STAFF' });
      expect(lastAudit().metadata).toEqual({
        reason: 'COMMUNICATION_PREFERENCES_CHANGED',
        origin: 'STAFF',
        changedFields: ['reminderOptOutAt'],
      });
    });

    it('audita la reactivación efectiva de una baja concurrente posterior a lecturaACTIVE', async () => {
      repo.add(ANA);
      const originalUpdate = repo.update.bind(repo);
      jest.spyOn(repo, 'update').mockImplementationOnce((...args) => {
        repo.add(ANA, {
          reminderOptOutAt: new Date(NOW.getTime() - 1000),
          reminderOptOutSource: 'LINK',
          phone: '+573209876543',
          contactChannel: 'NONE',
        });
        return originalUpdate(...args);
      });
      const result = await update.execute(ANA, { reminderOptOut: false }, ctx);
      expect(result).toMatchObject({
        reminderOptOut: null,
        phone: '+573209876543',
        contactChannel: 'NONE',
      });
      expect(audit.record).toHaveBeenCalledTimes(1);
      expect(lastAudit()).toMatchObject({
        actor: { kind: 'user', userId: RECEPTION, role: 'RECEPTION' },
        metadata: { origin: 'STAFF', changedFields: ['reminderOptOutAt'] },
      });
    });

    it('no audita una reactivación que ya realizó otra petición antes del lock', async () => {
      repo.add(ANA, { reminderOptOutAt: NOW, reminderOptOutSource: 'LINK' });
      const originalUpdate = repo.update.bind(repo);
      jest.spyOn(repo, 'update').mockImplementationOnce((...args) => {
        repo.add(ANA);
        return originalUpdate(...args);
      });
      await update.execute(ANA, { reminderOptOut: false }, ctx);
      expect(audit.record).not.toHaveBeenCalled();
    });

    it('reactivar invalida aunque lectura previa dijera activo, sin auditoría ficticia', async () => {
      repo.add(ANA);
      const write = jest.spyOn(repo, 'update');
      await update.execute(ANA, { reminderOptOut: false }, ctx);
      expect(write).toHaveBeenCalledWith(ANA, expect.any(Function), NOW);
      expect(audit.record).not.toHaveBeenCalled();
    });

    it('reactivar los recordatorios borra la baja (queda auditado)', async () => {
      repo.add(ANA, { reminderOptOutAt: NOW, reminderOptOutSource: 'LINK' });
      const write = jest.spyOn(repo, 'update');
      const view = await update.execute(ANA, { reminderOptOut: false }, ctx);
      expect(write).toHaveBeenCalledWith(ANA, expect.any(Function), NOW);
      expect(view.reminderOptOut).toBeNull();
      expect(lastAudit().metadata.changedFields).toEqual(['reminderOptOutAt']);
    });
  });
});

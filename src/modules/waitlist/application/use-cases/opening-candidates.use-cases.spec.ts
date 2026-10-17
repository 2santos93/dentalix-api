import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import {
  CreateWaitlistOfferUseCase,
  ListOpeningCandidatesUseCase,
  RecordWaitlistOfferOutcomeUseCase,
} from './opening-candidates.use-cases';
import { InMemoryOpeningCandidatesRepository } from '../__fixtures__/in-memory-opening-candidates';
import type {
  AppointmentCandidateRow,
  EntryCandidateRow,
} from '../../domain/ports/opening-candidates-repository.port';
import type { LocationRepository } from '../../../locations/domain/ports/location-repository.port';
import type { StaffRepository } from '../../../staff/domain/ports/staff-repository.port';
import type { RecordAuditEventUseCase } from '../../../audit/application/record-audit-event.use-case';
import type { AuditEventDraft } from '../../../audit/domain/audit-event';
import type { AuditRequestContext } from '../../../audit/domain/audit-request-context';

// Hoy es el lunes 19/10/2026 a las 08:00 en Bogotá; el hueco, el martes 20 de
// 10:00 a 10:30 con la Dra. X en la sede 1.
const local = (day: string, hhmm: string) =>
  new Date(`${day}T${hhmm}:00-05:00`);
const NOW = local('2026-10-19', '08:00');
const clock = () => NOW;
const SLOT = {
  locationId: 'loc1',
  providerId: 'drx',
  start: local('2026-10-20', '10:00'),
  end: local('2026-10-20', '10:30'),
};

const locations = {
  findById: (id: string) =>
    Promise.resolve(
      ['loc1', 'loc2'].includes(id)
        ? { id, name: 'Sede', country: 'CO', timeZone: 'America/Bogota' }
        : null,
    ),
} as unknown as LocationRepository;
const staff = {
  findById: (userId: string) =>
    Promise.resolve(['drx', 'dry'].includes(userId) ? { userId } : null),
} as unknown as StaffRepository;
const config = { offersPerPatientPerDay: 2 };

function audit(drafts: AuditEventDraft[]): RecordAuditEventUseCase {
  return {
    record: (d: AuditEventDraft) => {
      drafts.push(d);
      return Promise.resolve();
    },
  } as unknown as RecordAuditEventUseCase;
}

const CTX: AuditRequestContext = {
  tenantId: 't1',
  locationId: 'loc1',
  actor: { userId: 'u-rec', role: 'RECEPTION' },
  requestId: 'req-1',
  ip: null,
  userAgent: null,
};
const RECEPTION = { userId: 'u-rec', role: 'RECEPTION' as const };

describe('«Ocupar este hueco» (DX-210)', () => {
  let repo: InMemoryOpeningCandidatesRepository;
  let drafts: AuditEventDraft[];
  let list: ListOpeningCandidatesUseCase;
  let offer: CreateWaitlistOfferUseCase;
  let outcome: RecordWaitlistOfferOutcomeUseCase;

  function addEntry(
    id: string,
    patientId: string,
    over: Partial<EntryCandidateRow> = {},
  ) {
    const patient =
      repo.patients.find((p) => p.id === patientId) ??
      repo.addPatient({ id: patientId });
    const row: EntryCandidateRow = {
      id,
      locationId: 'loc1',
      providerId: null,
      durationMinutes: 30,
      priority: 'NORMAL',
      status: 'OPEN',
      createdAt: new Date('2026-10-01T12:00:00Z'),
      sourceAppointment: null,
      patient,
      appointmentType: null,
      preferredWindow: 'Mañanas',
      note: null,
      ...over,
    };
    repo.entries.push(row);
    return row;
  }

  function addAppointment(
    id: string,
    patientId: string,
    over: Partial<AppointmentCandidateRow> = {},
  ) {
    const patient = repo.addPatient({ id: patientId });
    const row: AppointmentCandidateRow = {
      id,
      locationId: 'loc1',
      providerId: 'drx',
      start: local('2026-11-10', '09:00'),
      end: local('2026-11-10', '09:30'),
      status: 'SCHEDULED',
      wantsEarlier: true,
      createdAt: new Date('2026-10-01T12:00:00Z'),
      patient,
      appointmentType: null,
      reason: 'Control',
      ...over,
    };
    repo.appointments.push(row);
    return row;
  }

  beforeEach(() => {
    repo = new InMemoryOpeningCandidatesRepository();
    drafts = [];
    list = new ListOpeningCandidatesUseCase(
      repo,
      locations,
      staff,
      config,
      clock,
    );
    offer = new CreateWaitlistOfferUseCase(
      repo,
      locations,
      staff,
      audit(drafts),
      config,
      clock,
    );
    outcome = new RecordWaitlistOfferOutcomeUseCase(repo, audit(drafts));
  });

  describe('candidatos', () => {
    it('URGENT antes que NORMAL, luego la cita a adelantar; el de 60 min y el de otra sede no salen', async () => {
      addEntry('normal', 'p-normal');
      addEntry('urgente', 'p-urgente', { priority: 'URGENT' });
      addEntry('largo', 'p-largo', { durationMinutes: 60 });
      addEntry('otra-sede', 'p-otra', { locationId: 'loc2' });
      addAppointment('cita', 'p-cita');
      addAppointment('mismo-dia', 'p-mismo-dia', {
        start: local('2026-10-20', '16:00'),
        end: local('2026-10-20', '16:30'),
      });

      const view = await list.execute(SLOT, RECEPTION);
      expect(view.items.map((i) => i.patientId)).toEqual([
        'p-urgente',
        'p-normal',
        'p-cita',
      ]);
      expect(view).toMatchObject({
        timeZone: 'America/Bogota',
        offerCap: 2,
        truncated: false,
      });
      expect(view.items[2]).toMatchObject({
        kind: 'APPOINTMENT',
        appointmentId: 'cita',
        durationMinutes: 30,
        currentAppointment: { id: 'cita', start: local('2026-11-10', '09:00') },
        whatsappPhone: '573101234567',
        whatsappBlocked: false,
      });
    });

    it('cuenta las ofertas de hoy y marca «aviso enviado» del hueco', async () => {
      addEntry('e1', 'p1');
      await offer.execute(
        {
          ...SLOT,
          slotStart: SLOT.start,
          slotEnd: SLOT.end,
          patientId: 'p1',
          providerId: 'drx',
          channel: 'PHONE',
          outcome: 'NO_ANSWER',
        },
        CTX,
      );
      const view = await list.execute(SLOT, RECEPTION);
      expect(view.items[0]).toMatchObject({
        offersToday: 1,
        offeredForSlot: true,
      });
    });

    it('un paciente con baja de los avisos sale bloqueado para WhatsApp', async () => {
      repo.addPatient({ id: 'p-baja', reminderOptOutAt: new Date() });
      addEntry('e', 'p-baja');
      const [item] = (await list.execute(SLOT, RECEPTION)).items;
      expect(item).toMatchObject({
        whatsappBlocked: true,
        whatsappPhone: null,
      });
    });

    it('sin el permiso de WhatsApp (DX-128) sale bloqueado, con el motivo', async () => {
      repo.addPatient({ id: 'p-sin-permiso', whatsappOptInAt: null });
      addEntry('e', 'p-sin-permiso');
      const [item] = (await list.execute(SLOT, RECEPTION)).items;
      expect(item).toMatchObject({
        whatsappBlocked: true,
        whatsappBlockedReason: 'NO_OPT_IN',
        whatsappPhone: null,
      });
    });

    it('la oferta por WhatsApp sin respuesta del hueco viaja como `pendingOfferId`', async () => {
      addEntry('e1', 'p1');
      const wa = await offer.execute(
        {
          locationId: 'loc1',
          slotStart: SLOT.start,
          slotEnd: SLOT.end,
          patientId: 'p1',
          providerId: 'drx',
          waitlistEntryId: 'e1',
          channel: 'WA_ME',
        },
        CTX,
      );
      let [item] = (await list.execute(SLOT, RECEPTION)).items;
      expect(item.pendingOfferId).toBe(wa.id);
      await outcome.execute(wa.id, 'DECLINED', CTX);
      [item] = (await list.execute(SLOT, RECEPTION)).items;
      expect(item.pendingOfferId).toBeNull();
    });

    it('DENTIST: solo su propia columna (403 en la de otro o sin columna)', async () => {
      const dentist = { userId: 'drx', role: 'DENTIST' as const };
      await expect(list.execute(SLOT, dentist)).resolves.toBeDefined();
      await expect(
        list.execute({ ...SLOT, providerId: 'dry' }, dentist),
      ).rejects.toBeInstanceOf(ForbiddenException);
      await expect(
        list.execute({ ...SLOT, providerId: undefined }, dentist),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('hueco inválido o pasado: 400; sede o profesional ajenos: 404', async () => {
      await expect(
        list.execute({ ...SLOT, end: SLOT.start }, RECEPTION),
      ).rejects.toBeInstanceOf(BadRequestException);
      await expect(
        list.execute(
          {
            ...SLOT,
            start: local('2026-10-18', '10:00'),
            end: local('2026-10-18', '10:30'),
          },
          RECEPTION,
        ),
      ).rejects.toThrow('Este hueco ya pasó');
      await expect(
        list.execute({ ...SLOT, locationId: 'ajena' }, RECEPTION),
      ).rejects.toBeInstanceOf(NotFoundException);
      await expect(
        list.execute({ ...SLOT, providerId: 'ajeno' }, RECEPTION),
      ).rejects.toBeInstanceOf(NotFoundException);
    });
  });

  describe('ofertas', () => {
    const base = {
      locationId: 'loc1',
      slotStart: SLOT.start,
      slotEnd: SLOT.end,
      providerId: 'drx',
      patientId: 'p1',
    };

    it('la tercera oferta del día al mismo paciente: 409 «Ya se le ofrecieron 2 huecos hoy»', async () => {
      addEntry('e1', 'p1');
      await offer.execute(
        { ...base, waitlistEntryId: 'e1', channel: 'WA_ME' },
        CTX,
      );
      await offer.execute(
        { ...base, channel: 'PHONE', outcome: 'NO_ANSWER' },
        CTX,
      );
      await expect(
        offer.execute({ ...base, channel: 'WA_ME' }, CTX),
      ).rejects.toThrow(
        new ConflictException('Ya se le ofrecieron 2 huecos hoy'),
      );
      expect(repo.offers).toHaveLength(2);
    });

    it('el tope se cuenta por día civil de la sede: ayer no cuenta', async () => {
      repo.addPatient({ id: 'p1' });
      for (const day of ['2026-10-18', '2026-10-18']) {
        repo.offers.push({
          id: `old-${repo.offers.length}`,
          ...base,
          waitlistEntryId: null,
          appointmentId: null,
          channel: 'PHONE',
          outcome: 'DECLINED',
          offerDay: day,
          createdById: 'u',
          outcomeById: 'u',
          outcomeAt: new Date(),
          createdAt: new Date(),
        });
      }
      const created = await offer.execute({ ...base, channel: 'WA_ME' }, CTX);
      expect(created).toMatchObject({
        offerDay: '2026-10-19',
        offersToday: 1,
        offerCap: 2,
        outcome: 'PENDING',
      });
    });

    it('queda auditada sin el contenido del mensaje', async () => {
      addEntry('e1', 'p1');
      const created = await offer.execute(
        { ...base, waitlistEntryId: 'e1', channel: 'WA_ME' },
        CTX,
      );
      expect(drafts).toEqual([
        expect.objectContaining({
          action: 'CREATE',
          resourceType: 'WAITLIST_OFFER',
          resourceId: created.id,
          patient: { kind: 'patient', id: 'p1' },
          metadata: { reason: 'OFFER_WA_ME' },
        }),
      ]);
    });

    it('por WhatsApp a un paciente con baja (DX-128): 409, se le llama', async () => {
      repo.addPatient({ id: 'p1', reminderOptOutAt: new Date() });
      await expect(
        offer.execute({ ...base, channel: 'WA_ME' }, CTX),
      ).rejects.toThrow(/Llámalo/);
      await expect(
        offer.execute({ ...base, channel: 'PHONE', outcome: 'ACCEPTED' }, CTX),
      ).resolves.toMatchObject({ outcome: 'ACCEPTED', outcomeById: 'u-rec' });
    });

    it('por WhatsApp sin el permiso de WhatsApp registrado (DX-128): 409, se le llama', async () => {
      repo.addPatient({ id: 'p1', whatsappOptInAt: null });
      await expect(
        offer.execute({ ...base, channel: 'WA_ME' }, CTX),
      ).rejects.toThrow(
        new ConflictException(
          'Este paciente no ha dado permiso para escribirle por WhatsApp. Llámalo.',
        ),
      );
      expect(repo.offers).toHaveLength(0);
    });

    it('por WhatsApp sin móvil válido: 409; por WhatsApp no se anota resultado al ofrecer: 400', async () => {
      repo.addPatient({ id: 'p1', phone: null });
      await expect(
        offer.execute({ ...base, channel: 'WA_ME' }, CTX),
      ).rejects.toThrow(/móvil válido/);
      await expect(
        offer.execute({ ...base, channel: 'WA_ME', outcome: 'ACCEPTED' }, CTX),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('el pendiente o la cita tienen que ser del paciente, de la sede y seguir vigentes', async () => {
      addEntry('e-otro', 'p-otro');
      repo.addPatient({ id: 'p1' });
      addAppointment('cita-sin-marca', 'p1', { wantsEarlier: false });
      await expect(
        offer.execute(
          {
            ...base,
            waitlistEntryId: 'e-otro',
            channel: 'PHONE',
            outcome: 'DECLINED',
          },
          CTX,
        ),
      ).rejects.toBeInstanceOf(ConflictException);
      await expect(
        offer.execute(
          {
            ...base,
            appointmentId: 'cita-sin-marca',
            channel: 'PHONE',
            outcome: 'DECLINED',
          },
          CTX,
        ),
      ).rejects.toBeInstanceOf(ConflictException);
      await expect(
        offer.execute(
          {
            ...base,
            waitlistEntryId: 'no-existe',
            channel: 'PHONE',
            outcome: 'DECLINED',
          },
          CTX,
        ),
      ).rejects.toBeInstanceOf(NotFoundException);
      await expect(
        offer.execute(
          {
            ...base,
            patientId: 'ajeno',
            channel: 'PHONE',
            outcome: 'DECLINED',
          },
          CTX,
        ),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('anotar la respuesta una sola vez, auditada', async () => {
      repo.addPatient({ id: 'p1' });
      const created = await offer.execute({ ...base, channel: 'WA_ME' }, CTX);
      await expect(
        outcome.execute(created.id, 'ACCEPTED', CTX),
      ).resolves.toMatchObject({ outcome: 'ACCEPTED', outcomeById: 'u-rec' });
      await expect(
        outcome.execute(created.id, 'DECLINED', CTX),
      ).rejects.toBeInstanceOf(ConflictException);
      await expect(
        outcome.execute('no-existe', 'DECLINED', CTX),
      ).rejects.toBeInstanceOf(NotFoundException);
      expect(drafts.map((d) => d.metadata.reason)).toEqual([
        'OFFER_WA_ME',
        'OFFER_ACCEPTED',
      ]);
    });
  });
});

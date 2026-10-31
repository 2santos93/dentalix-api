import { ConflictException, BadRequestException } from '@nestjs/common';
import { CreateWaitlistOfferUseCase } from './opening-candidates.use-cases';
import { CreateLinkOfferUseCase } from './link-offers.use-cases';
import { InMemoryOpeningCandidatesRepository } from '../__fixtures__/in-memory-opening-candidates';
import type { LocationRepository } from '../../../locations/domain/ports/location-repository.port';
import type { StaffRepository } from '../../../staff/domain/ports/staff-repository.port';
import type { RecordAuditEventUseCase } from '../../../audit/application/record-audit-event.use-case';
import type { AuditEventDraft } from '../../../audit/domain/audit-event';
import type { AuditRequestContext } from '../../../audit/domain/audit-request-context';
import { TenantContextService } from '../../../../shared/tenancy/tenant-context.service';
import type { SlotOfferEmailSender } from '../slot-offer-email';
import type { SlotOfferRepository } from '../../domain/ports/slot-offer-repository.port';
import type { SlotOfferEmailVars } from '../../../notifications/email/domain/email-message';
import {
  LINK_OFFER_TOO_LATE_MESSAGE,
  OFFER_EMAIL_BLOCKED_MESSAGE,
  OFFER_EMAIL_MISSING_MESSAGE,
  hashSlotOfferToken,
} from '../../domain/slot-offer-link';

const local = (day: string, hhmm: string) =>
  new Date(`${day}T${hhmm}:00-05:00`);
let now = local('2026-10-19', '08:00');
const clock = () => now;

const locations = {
  findById: (id: string) =>
    Promise.resolve(
      id === 'loc1'
        ? {
            id,
            name: 'Sede Centro',
            country: 'CO',
            defaultPhoneRegion: 'CO',
            timeZone: 'America/Bogota',
            locale: 'es-CO',
            hourCycle: 'h12',
          }
        : null,
    ),
} as unknown as LocationRepository;
const staff = {
  findById: (userId: string) =>
    Promise.resolve(
      userId === 'drx' ? { userId, fullName: 'Dra. Ximena Ruiz' } : null,
    ),
} as unknown as StaffRepository;
const slotOffers = {
  findClinicBranding: () =>
    Promise.resolve({ name: 'Sonrisas', primaryColor: null, logoUrl: null }),
} as unknown as SlotOfferRepository;

const CTX: AuditRequestContext = {
  tenantId: 't1',
  locationId: 'loc1',
  actor: { userId: 'u-rec', role: 'RECEPTION' },
  requestId: 'req-1',
  ip: null,
  userAgent: null,
};
const LINK = { protocol: 'https' as const, host: 'demo.dentalix.app' };

describe('«Enviar oferta con enlace» (DX-435)', () => {
  let repo: InMemoryOpeningCandidatesRepository;
  let drafts: AuditEventDraft[];
  let sent: { to: string; referenceId: string; vars: SlotOfferEmailVars }[];
  let useCase: CreateLinkOfferUseCase;
  let leadMinutes: number;

  const base = {
    locationId: 'loc1',
    slotStart: local('2026-10-20', '10:00'),
    slotEnd: local('2026-10-20', '10:30'),
    providerId: 'drx',
    patientId: 'p1',
  };

  beforeEach(() => {
    now = local('2026-10-19', '08:00');
    leadMinutes = 0;
    repo = new InMemoryOpeningCandidatesRepository();
    repo.addPatient({ id: 'p1', firstName: 'Ana María', lastName: 'Pérez' });
    drafts = [];
    sent = [];
    const email: SlotOfferEmailSender = {
      assertCanSend: () => Promise.resolve(),
      send: (input) => {
        sent.push(input);
        return Promise.resolve();
      },
    };
    const audit = {
      record: (d: AuditEventDraft) => {
        drafts.push(d);
        return Promise.resolve();
      },
    } as unknown as RecordAuditEventUseCase;
    const create = new CreateWaitlistOfferUseCase(
      repo,
      locations,
      staff,
      audit,
      { offersPerPatientPerDay: 2 },
      clock,
      new TenantContextService(),
    );
    useCase = new CreateLinkOfferUseCase(
      create,
      repo,
      locations,
      staff,
      slotOffers,
      email,
      {
        get expiryLeadMinutes() {
          return leadMinutes;
        },
      },
      clock,
    );
  });

  it('por email: guarda solo el hash del token, caduca al empezar el hueco y encola el email sin datos clínicos', async () => {
    const view = await useCase.execute(
      { ...base, channel: 'LINK_EMAIL' },
      LINK,
      CTX,
    );
    expect(view.outcome).toBe('PENDING');
    expect(view.expiresAt).toEqual(base.slotStart);
    // Por email el enlace no vuelve al panel.
    expect(view.url).toBeNull();
    expect(sent).toHaveLength(1);
    const url = sent[0].vars.url;
    expect(url).toMatch(/^https:\/\/demo\.dentalix\.app\/hueco\/[A-Za-z0-9_-]{43}$/);
    const token = url.split('/').pop()!;
    expect(repo.tokenHashes.get(view.id)).toBe(hashSlotOfferToken(token));
    expect(sent[0].to).toBe('p1@example.com');
    expect(sent[0].vars.patientFirstName).toBe('Ana');
    expect(sent[0].vars.providerName).toBe('Dra. Ximena Ruiz');
    expect(sent[0].vars.locationName).toBe('Sede Centro');
    expect(JSON.stringify(sent[0].vars)).not.toContain('Pérez');
    expect(drafts.map((d) => d.metadata)).toEqual([
      { reason: 'OFFER_LINK_EMAIL' },
    ]);
  });

  it('por WhatsApp: devuelve el enlace para el texto prellenado de wa.me', async () => {
    const view = await useCase.execute(
      { ...base, channel: 'LINK_WA_ME' },
      LINK,
      CTX,
    );
    expect(view.url).toMatch(/\/hueco\/[A-Za-z0-9_-]{43}$/);
    expect(view.whatsappPhone).toBe('573101234567');
    expect(sent).toHaveLength(0);
  });

  it('con antelación configurada, caduca antes del hueco', async () => {
    leadMinutes = 60;
    const view = await useCase.execute(
      { ...base, channel: 'LINK_EMAIL' },
      LINK,
      CTX,
    );
    expect(view.expiresAt).toEqual(local('2026-10-20', '09:00'));
  });

  it('con menos de 20 minutos para el hueco no se crea la oferta', async () => {
    now = new Date(base.slotStart.getTime() - 19 * 60_000);
    await expect(
      useCase.execute({ ...base, channel: 'LINK_EMAIL' }, LINK, CTX),
    ).rejects.toThrow(new ConflictException(LINK_OFFER_TOO_LATE_MESSAGE));
    expect(repo.offers).toHaveLength(0);
    expect(sent).toHaveLength(0);
  });

  it('respeta la baja y el canal de DX-128 y exige email', async () => {
    repo.addPatient({ id: 'p2', reminderOptOutAt: new Date() });
    repo.addPatient({ id: 'p3', email: null });
    await expect(
      useCase.execute(
        { ...base, patientId: 'p2', channel: 'LINK_EMAIL' },
        LINK,
        CTX,
      ),
    ).rejects.toThrow(new ConflictException(OFFER_EMAIL_BLOCKED_MESSAGE));
    await expect(
      useCase.execute(
        { ...base, patientId: 'p3', channel: 'LINK_EMAIL' },
        LINK,
        CTX,
      ),
    ).rejects.toThrow(new ConflictException(OFFER_EMAIL_MISSING_MESSAGE));
    expect(repo.offers).toHaveLength(0);
  });

  it('mantiene el tope diario por paciente de DX-210', async () => {
    await useCase.execute({ ...base, channel: 'LINK_EMAIL' }, LINK, CTX);
    await useCase.execute({ ...base, channel: 'LINK_WA_ME' }, LINK, CTX);
    await expect(
      useCase.execute({ ...base, channel: 'LINK_EMAIL' }, LINK, CTX),
    ).rejects.toThrow(new ConflictException('Ya se le ofrecieron 2 huecos hoy'));
  });

  it('la oferta con enlace no se crea por la ruta de anotar (sin token)', async () => {
    const create = new CreateWaitlistOfferUseCase(
      repo,
      locations,
      staff,
      { record: () => Promise.resolve() } as unknown as RecordAuditEventUseCase,
      { offersPerPatientPerDay: 2 },
      clock,
      new TenantContextService(),
    );
    await expect(
      create.execute({ ...base, channel: 'LINK_EMAIL' }, CTX),
    ).rejects.toThrow(BadRequestException);
  });
});

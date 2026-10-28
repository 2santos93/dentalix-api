import { randomUUID } from 'node:crypto';
import type { PostOpDelivery } from '../../domain/entities/post-op-delivery.entity';
import type {
  CreatePostOpDeliveryRepoInput,
  PostOpAppointmentContext,
  PostOpDeliveryDocumentView,
  PostOpDeliveryRepository,
  PostOpPublicDeliveryView,
} from '../../domain/ports/post-op-delivery-repository.port';
import type { PostOpEmailSender, PostOpEmailSendInput } from '../postop-email';

export const APPOINTMENT_ID = 'appt-1';
export const PATIENT_ID = 'pat-1';

/** Cita de un adulto con email y móvil, en una sede con teléfono y ajustes explícitos. */
export function appointmentContext(
  overrides: {
    appointment?: Partial<PostOpAppointmentContext['appointment']>;
    patient?: Partial<PostOpAppointmentContext['patient']>;
    location?: Partial<PostOpAppointmentContext['location']>;
    responsibles?: PostOpAppointmentContext['responsibles'];
    clinicName?: string;
    majorityAge?: number;
  } = {},
): PostOpAppointmentContext {
  return {
    appointment: {
      id: APPOINTMENT_ID,
      patientId: PATIENT_ID,
      locationId: 'loc-1',
      appointmentTypeId: 'type-cx',
      // 20/10/2026 a las 21:30 en la zona de la sede (ya 21/10 en UTC).
      start: new Date('2026-10-21T02:30:00.000Z'),
      providerName: 'Dra. Laura Gómez',
      ...overrides.appointment,
    },
    patient: {
      firstName: 'Carolina',
      lastName: 'Duque',
      email: 'carolina.duque@example.com',
      phone: '+57 310 123 4567',
      birthDate: new Date('1990-05-01T00:00:00.000Z'),
      emergencyContactName: null,
      reminderOptOutAt: null,
      contactChannel: 'EMAIL',
      ...overrides.patient,
    },
    responsibles: overrides.responsibles ?? [],
    location: {
      id: 'loc-1',
      name: 'Sede Norte',
      phone: '601 555 0101',
      country: 'CO',
      timeZone: 'America/Bogota',
      locale: 'es-CO',
      hourCycle: 'h23',
      ...overrides.location,
    },
    clinicName: overrides.clinicName ?? 'Sonrisas del Norte',
    majorityAge: overrides.majorityAge ?? 18,
  };
}

/**
 * Repositorio en memoria con estado: `rows` hace de la tabla de entregas y
 * `contexts` de las citas visibles en la clínica.
 */
export class InMemoryPostOpDeliveryRepository implements PostOpDeliveryRepository {
  readonly rows: PostOpDelivery[] = [];
  readonly contexts = new Map<string, PostOpAppointmentContext>();
  readonly performed = new Map<string, string[]>();
  readonly performedQueries: Array<{ day: string; timeZone: string }> = [];
  readonly users = new Map<string, string>([['user-1', 'Recepción Demo']]);
  /** Búsquedas por token y aperturas marcadas, para afirmar qué se tocó. */
  tokenLookups = 0;
  openedMarks = 0;
  private clock = Date.parse('2026-10-20T15:00:00.000Z');

  loadAppointmentContext(
    appointmentId: string,
  ): Promise<PostOpAppointmentContext | null> {
    return Promise.resolve(this.contexts.get(appointmentId) ?? null);
  }

  performedCatalogItemIds(input: {
    appointmentId: string;
    patientId: string;
    day: string;
    timeZone: string;
  }): Promise<string[]> {
    this.performedQueries.push({ day: input.day, timeZone: input.timeZone });
    return Promise.resolve(this.performed.get(input.appointmentId) ?? []);
  }

  userName(userId: string): Promise<string | null> {
    return Promise.resolve(this.users.get(userId) ?? null);
  }

  create(input: CreatePostOpDeliveryRepoInput): Promise<PostOpDelivery> {
    // Cada entrega un instante después de la anterior, como la hora de la BD.
    const at = new Date((this.clock += 1000));
    const row: PostOpDelivery = {
      id: randomUUID(),
      tenantId: 't1',
      ...input,
      deliveredAt: at,
      firstOpenedAt: null,
      createdAt: at,
    };
    this.rows.push(row);
    return Promise.resolve({ ...row });
  }

  listByAppointment(appointmentId: string): Promise<PostOpDelivery[]> {
    return Promise.resolve(
      this.newestFirst().filter((r) => r.appointmentId === appointmentId),
    );
  }

  listByPatient(patientId: string): Promise<PostOpDelivery[]> {
    return Promise.resolve(
      this.newestFirst().filter((r) => r.patientId === patientId),
    );
  }

  findForPatient(
    patientId: string,
    id: string,
  ): Promise<PostOpDeliveryDocumentView | null> {
    const row = this.rows.find((r) => r.id === id && r.patientId === patientId);
    const ctx = row ? this.contexts.get(row.appointmentId) : undefined;
    if (!row || !ctx) return Promise.resolve(null);
    return Promise.resolve({
      ...row,
      clinic: { name: ctx.clinicName, logoUrl: null, primaryColor: '#0F5E9C' },
      locationName: ctx.location.name,
      locationPhone: ctx.location.phone,
      patientName: `${ctx.patient.firstName} ${ctx.patient.lastName}`,
    });
  }

  findByTokenHash(tokenHash: string): Promise<PostOpPublicDeliveryView | null> {
    this.tokenLookups++;
    const row = this.rows.find((r) => r.tokenHash === tokenHash);
    const ctx = row ? this.contexts.get(row.appointmentId) : undefined;
    if (!row || !ctx) return Promise.resolve(null);
    return Promise.resolve({
      ...row,
      clinic: { name: ctx.clinicName, logoUrl: null, primaryColor: '#0F5E9C' },
      locationPhone: ctx.location.phone,
    });
  }

  markFirstOpened(id: string): Promise<boolean> {
    const row = this.rows.find((r) => r.id === id && r.firstOpenedAt === null);
    if (!row) return Promise.resolve(false);
    row.firstOpenedAt = new Date((this.clock += 1000));
    this.openedMarks++;
    return Promise.resolve(true);
  }

  private newestFirst(): PostOpDelivery[] {
    return [...this.rows].sort(
      (a, b) => b.deliveredAt.getTime() - a.deliveredAt.getTime(),
    );
  }
}

/** Envío de email falso: guarda lo encolado y puede simular el tope (429). */
export class FakePostOpEmailSender implements PostOpEmailSender {
  readonly sent: PostOpEmailSendInput[] = [];
  readonly checked: string[] = [];
  quotaError: Error | null = null;

  assertCanSend(to: string): Promise<void> {
    this.checked.push(to);
    return this.quotaError
      ? Promise.reject(this.quotaError)
      : Promise.resolve();
  }

  send(input: PostOpEmailSendInput): Promise<void> {
    this.sent.push(input);
    return Promise.resolve();
  }
}

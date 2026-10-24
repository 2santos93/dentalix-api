import { AppointmentStatus, ClinicRole, PrismaClient } from '@prisma/client';

/**
 * DX-014: actividad fija de una clínica para los reportes, sembrada por `raw`
 * (DIRECT_URL, owner) para que las fechas sean exactas: los casos de uso no
 * registran el pasado. Las horas van en UTC; las sedes de los tests están en
 * America/Bogota (UTC−5 fijo).
 */
export class ReportSeeder {
  private readonly taken = new Set<string>();
  private catalogItemId: string | null = null;
  private membership: { id: string; userId: string } | null = null;

  constructor(
    private readonly raw: PrismaClient,
    readonly tenantId: string,
  ) {}

  async location(name: string): Promise<string> {
    const location = await this.raw.location.create({
      data: { tenantId: this.tenantId, name },
      select: { id: true },
    });
    return location.id;
  }

  async patient(lastName: string): Promise<string> {
    const patient = await this.raw.patient.create({
      data: { tenantId: this.tenantId, firstName: 'Paciente', lastName },
      select: { id: true },
    });
    return patient.id;
  }

  /** Profesional que realiza los ítems (DX-050) y atiende las citas. */
  async dentist(): Promise<{ id: string; userId: string }> {
    if (this.membership) return this.membership;
    const user = await this.raw.user.create({
      data: {
        email: `reportes-${this.tenantId}@example.com`,
        passwordHash: 'x',
        fullName: 'Dra. Reportes',
      },
      select: { id: true },
    });
    this.membership = await this.raw.clinicMembership.create({
      data: {
        tenantId: this.tenantId,
        userId: user.id,
        role: ClinicRole.DENTIST,
      },
      select: { id: true, userId: true },
    });
    return this.membership;
  }

  /** Otro profesional (DENTIST) de la clínica; devuelve su usuario. */
  async provider(fullName: string): Promise<string> {
    const user = await this.raw.user.create({
      data: {
        email: `${fullName.toLowerCase().replace(/\W+/g, '-')}-${this.tenantId}@example.com`,
        passwordHash: 'x',
        fullName,
      },
      select: { id: true },
    });
    await this.raw.clinicMembership.create({
      data: {
        tenantId: this.tenantId,
        userId: user.id,
        role: ClinicRole.DENTIST,
      },
    });
    return user.id;
  }

  /** Horario semanal de un profesional en una sede (DX-233). */
  async providerSchedule(input: {
    providerId: string;
    locationId: string;
    ranges: { weekday: number; startMinute: number; endMinute: number }[];
  }): Promise<void> {
    const schedule = await this.raw.providerSchedule.create({
      data: {
        tenantId: this.tenantId,
        providerId: input.providerId,
        locationId: input.locationId,
        timezone: 'America/Bogota',
      },
      select: { id: true },
    });
    await this.raw.providerScheduleRange.createMany({
      data: input.ranges.map((r) => ({
        tenantId: this.tenantId,
        scheduleId: schedule.id,
        providerId: input.providerId,
        ...r,
      })),
    });
  }

  /** Horario semanal de la sede (DX-122). */
  async locationSchedule(
    locationId: string,
    ranges: { weekday: number; startMinute: number; endMinute: number }[],
  ): Promise<void> {
    const schedule = await this.raw.locationSchedule.create({
      data: { tenantId: this.tenantId, locationId, timezone: 'America/Bogota' },
      select: { id: true },
    });
    await this.raw.locationScheduleRange.createMany({
      data: ranges.map((r) => ({
        tenantId: this.tenantId,
        scheduleId: schedule.id,
        ...r,
      })),
    });
  }

  /** Una cita COMPLETED de `providerId` en `[start, start + minutes)`. */
  async completedVisit(input: {
    locationId: string;
    patientId: string;
    providerId: string;
    start: Date;
    minutes: number;
  }): Promise<void> {
    await this.raw.appointment.create({
      data: {
        tenantId: this.tenantId,
        locationId: input.locationId,
        patientId: input.patientId,
        providerId: input.providerId,
        start: input.start,
        end: new Date(input.start.getTime() + input.minutes * 60_000),
        status: 'COMPLETED',
      },
    });
  }

  /**
   * Un plan con un ítem DONE «Sin atribuir» (sin quién, dónde ni cuándo),
   * como los realizados antes de DX-050. Devuelve el plan y el ítem.
   */
  async unattributedDone(input: {
    patientId: string;
    currency: string;
    price: number;
  }): Promise<{ planId: string; itemId: string }> {
    const plan = await this.raw.treatmentPlan.create({
      data: {
        tenantId: this.tenantId,
        patientId: input.patientId,
        currency: input.currency,
        status: 'ACCEPTED',
      },
      select: { id: true },
    });
    const item = await this.raw.treatmentPlanItem.create({
      data: {
        tenantId: this.tenantId,
        planId: plan.id,
        toothNumber: '26',
        catalogItemId: await this.catalog(),
        price: input.price,
        status: 'DONE',
      },
      select: { id: true },
    });
    return { planId: plan.id, itemId: item.id };
  }

  private async catalog(): Promise<string> {
    if (this.catalogItemId) return this.catalogItemId;
    // Otro sembrador de la misma clínica puede haberlo creado ya.
    const code = `dx014-${this.tenantId.slice(0, 8)}`;
    const item =
      (await this.raw.dentalCatalogItem.findFirst({
        where: { tenantId: this.tenantId, code },
        select: { id: true },
      })) ??
      (await this.raw.dentalCatalogItem.create({
        data: {
          tenantId: this.tenantId,
          code,
          kind: 'PROCEDURE',
          labelEs: 'Resina',
          color: '#123456',
        },
        select: { id: true },
      }));
    this.catalogItemId = item.id;
    return item.id;
  }

  /** Un plan con un ítem; DONE en `locationId` a la hora `completedAt`. */
  async plan(input: {
    patientId: string;
    currency: string;
    price: number;
    discount?: number;
    done?: { locationId: string; at: Date };
  }): Promise<string> {
    const plan = await this.raw.treatmentPlan.create({
      data: {
        tenantId: this.tenantId,
        patientId: input.patientId,
        currency: input.currency,
        status: 'ACCEPTED',
      },
      select: { id: true },
    });
    const dentist = input.done ? await this.dentist() : null;
    await this.raw.treatmentPlanItem.create({
      data: {
        tenantId: this.tenantId,
        planId: plan.id,
        toothNumber: '16',
        catalogItemId: await this.catalog(),
        price: input.price,
        discount: input.discount ?? 0,
        status: input.done ? 'DONE' : 'ACCEPTED',
        ...(input.done && dentist
          ? {
              performedById: dentist.userId,
              performedByMembershipId: dentist.id,
              performedLocationId: input.done.locationId,
              completedAt: input.done.at,
            }
          : {}),
      },
    });
    return plan.id;
  }

  async payment(input: {
    planId: string;
    patientId: string;
    locationId: string;
    currency: string;
    amount: number;
    paidAt: Date;
    voided?: boolean;
  }): Promise<void> {
    await this.raw.payment.create({
      data: {
        tenantId: this.tenantId,
        treatmentPlanId: input.planId,
        patientId: input.patientId,
        locationId: input.locationId,
        currency: input.currency,
        amount: input.amount,
        paidAt: input.paidAt,
        deletedAt: input.voided ? new Date() : null,
      },
    });
  }

  /**
   * Una cita de 30 min desde las 10:00 de Bogotá (15:00 UTC) del día civil
   * `day`: cada cita del día en la siguiente media hora libre, para no chocar
   * con los EXCLUDE de profesional y paciente.
   */
  async appointment(input: {
    locationId: string;
    patientId: string;
    day: string;
    status: AppointmentStatus;
    /** Solo CANCELLED (DX-279): cancelada por el paciente, tardía o no. */
    lateCancellation?: boolean;
  }): Promise<void> {
    const dentist = await this.dentist();
    let offset = 0;
    while (this.taken.has(`${input.day}|${offset}`)) offset++;
    this.taken.add(`${input.day}|${offset}`);
    const start = new Date(`${input.day}T15:00:00Z`);
    start.setUTCMinutes(offset * 30);
    await this.raw.appointment.create({
      data: {
        tenantId: this.tenantId,
        locationId: input.locationId,
        patientId: input.patientId,
        providerId: dentist.userId,
        start,
        end: new Date(start.getTime() + 30 * 60_000),
        status: input.status,
        ...(input.lateCancellation === undefined
          ? {}
          : {
              cancelledAt: new Date(start.getTime() - 60 * 60_000),
              cancelledByKind: 'PATIENT_LINK' as const,
              noticeMinutes: input.lateCancellation ? 60 : 3 * 24 * 60,
              lateCancellation: input.lateCancellation,
            }),
      },
    });
  }

  /** `count` citas con ese estado, en días sucesivos desde `firstDay`. */
  async appointments(input: {
    locationId: string;
    patientIds: string[];
    firstDay: string;
    count: number;
    status: AppointmentStatus;
  }): Promise<void> {
    const [y, m, d] = input.firstDay.split('-').map(Number);
    for (let i = 0; i < input.count; i++) {
      const day = new Date(Date.UTC(y, m - 1, d + Math.floor(i / 8)))
        .toISOString()
        .slice(0, 10);
      await this.appointment({
        locationId: input.locationId,
        patientId: input.patientIds[i % input.patientIds.length],
        day,
        status: input.status,
      });
    }
  }
}

import {
  civilDateIn,
  civilDaysInclusive,
  addCivilDays,
  civilDayRange,
} from '../../../shared/time/civil-day';
import {
  loadPeriodLocationZones,
  resolveLocationTimeZones,
} from '../../../shared/locations/location-time-zone';
import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../../shared/prisma/prisma.service';
import { TenantContextService } from '../../../shared/tenancy/tenant-context.service';
import { whatsAppDigits } from '../../../shared/phone/phone-number';
import {
  minimumVisitDate,
  RESERVED_APPOINTMENT_STATUSES,
  validateVisits,
  VisitAssignment,
} from '../domain/plan-visits';

function futureAppointment(now: Date): Prisma.AppointmentWhereInput {
  return {
    deletedAt: null,
    status: {
      in: RESERVED_APPOINTMENT_STATUSES as (
        | 'SCHEDULED'
        | 'CONFIRMED'
        | 'ARRIVED'
        | 'IN_CHAIR'
        | 'READY_FOR_CHECKOUT'
      )[],
    },
    OR: [
      { start: { gte: now } },
      { status: { in: ['ARRIVED', 'IN_CHAIR', 'READY_FOR_CHECKOUT'] } },
    ],
  };
}

@Injectable()
export class PlanVisitsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly context: TenantContextService,
  ) {}
  async update(
    id: string,
    items: VisitAssignment[],
    visitIntervals: Record<string, number>,
  ) {
    await this.prisma.runWithTenant(async (tx) => {
      const locked = await tx.$queryRaw<
        { id: string }[]
      >`SELECT id FROM treatment_plans WHERE id=${id}::uuid AND "deletedAt" IS NULL FOR UPDATE`;
      if (!locked.length)
        throw new NotFoundException('Plan de tratamiento no encontrado');
      const plan = await tx.treatmentPlan.findUniqueOrThrow({
        where: { id },
        include: { items: { where: { deletedAt: null } } },
      });
      validateVisits(plan.status, items, visitIntervals);
      const ids = new Set(items.map((i) => i.itemId));
      if (
        ids.size !== plan.items.length ||
        plan.items.some((i) => !ids.has(i.id))
      )
        throw new BadRequestException(
          'Incluye todos los ítems vivos del plan una sola vez.',
        );
      await tx.treatmentPlan.update({
        where: { id },
        data: { visitIntervals },
      });
      for (const item of [...items].sort((a, b) =>
        a.itemId.localeCompare(b.itemId),
      )) {
        await tx.treatmentPlanItem.update({
          where: { id: item.itemId },
          data: {
            visit: item.visit,
            visitLabel: item.visitLabel?.trim() || null,
          },
        });
      }
    });
    return this.get(id);
  }
  async get(id: string) {
    const now = new Date();
    return this.prisma.runWithTenant(
      async (tx) => {
        const plan = await tx.treatmentPlan.findFirst({
          where: { id, deletedAt: null },
          include: {
            items: {
              where: { deletedAt: null },
              orderBy: [{ visit: 'asc' }, { createdAt: 'asc' }, { id: 'asc' }],
              include: {
                appointmentLinks: {
                  where: { deletedAt: null },
                  include: {
                    appointment: {
                      select: {
                        start: true,
                        end: true,
                        status: true,
                        deletedAt: true,
                      },
                    },
                  },
                },
              },
            },
          },
        });
        if (!plan)
          throw new NotFoundException('Plan de tratamiento no encontrado');
        const locationId =
          plan.acceptedLocationId ??
          plan.presentedLocationId ??
          (await this.context.writeLocationId(tx));
        const zoneOf = await resolveLocationTimeZones(
          tx,
          this.context.getTenantId()!,
          [locationId],
        );
        const timeZone = zoneOf(locationId);
        const intervals = plan.visitIntervals as Record<string, number>;
        const visits = [...new Set(plan.items.map((i) => i.visit))]
          .sort((a, b) => a - b)
          .map((number) => {
            const items = plan.items.filter((i) => i.visit === number);
            const previous = plan.items
              .filter((i) => i.visit === number - 1)
              .flatMap((i) => i.appointmentLinks)
              .filter(
                (l) =>
                  l.appointment.status === 'COMPLETED' &&
                  !l.appointment.deletedAt,
              )
              .map((l) => l.appointment.end);
            const last = previous.length
              ? new Date(Math.max(...previous.map((d) => d.getTime())))
              : null;
            const planItemIds =
              plan.status === 'ACCEPTED'
                ? items
                    .filter(
                      (i) =>
                        i.status === 'ACCEPTED' &&
                        !i.appointmentLinks.some(
                          (l) =>
                            !l.appointment.deletedAt &&
                            RESERVED_APPOINTMENT_STATUSES.includes(
                              l.appointment.status,
                            ) &&
                            (l.appointment.start >= now ||
                              [
                                'ARRIVED',
                                'IN_CHAIR',
                                'READY_FOR_CHECKOUT',
                              ].includes(l.appointment.status)),
                        ),
                    )
                    .map((i) => i.id)
                : [];
            return {
              number,
              label: items[0]?.visitLabel ?? null,
              minDaysAfterPrevious: intervals[String(number)] ?? 0,
              minimumDate: minimumVisitDate(
                last,
                intervals[String(number)] ?? 0,
                now,
                timeZone,
              ),
              minimumDay: civilDateIn(
                minimumVisitDate(
                  last,
                  intervals[String(number)] ?? 0,
                  now,
                  timeZone,
                ),
                timeZone,
              ),
              planItemIds,
            };
          });
        return {
          planId: plan.id,
          items: plan.items.map((i) => ({
            id: i.id,
            visit: i.visit,
            visitLabel: i.visitLabel,
          })),
          visitIntervals: intervals,
          visits,
        };
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead },
    );
  }
  async unscheduled(input: {
    locationId?: string;
    olderThanDays?: number;
    cursor?: string;
    limit?: number;
  }) {
    if (input.locationId) this.context.assertLocationAllowed(input.locationId);
    const now = new Date();
    const limit = Math.min(input.limit ?? 25, 50);
    const pending: Prisma.TreatmentPlanItemWhereInput = {
      deletedAt: null,
      status: 'ACCEPTED',
      appointmentLinks: {
        none: { deletedAt: null, appointment: futureAppointment(now) },
      },
    };
    const scopes = input.locationId
      ? [input.locationId]
      : this.context.scopeLocationIds();
    return this.prisma.runWithTenant(
      async (tx) => {
        const tenantId = this.context.getTenantId()!;
        const locations = await tx.location.findMany({
          where: { tenantId, ...(scopes ? { id: { in: scopes } } : {}) },
          select: { id: true },
        });
        // Una sede sin zona solo falla si tiene planes aceptados en ella (G1).
        const zones = await loadPeriodLocationZones(
          tx,
          tenantId,
          locations.map((l) => l.id),
          async (ids) =>
            (
              await tx.treatmentPlan.findFirst({
                where: { tenantId, acceptedLocationId: { in: ids } },
                select: { acceptedLocationId: true },
              })
            )?.acceptedLocationId,
        );
        const zoneOf = (locationId: string) => zones.zoneOf(locationId);
        const ageScope = [...zones.configured].map(([id, zone]) => ({
          acceptedLocationId: id,
          acceptedAt: {
            lt: civilDayRange(
              addCivilDays(
                civilDateIn(now, zone),
                1 - (input.olderThanDays ?? 0),
              ),
              zone,
            ).start,
          },
        }));
        const rows = await tx.treatmentPlan.findMany({
          where: {
            status: 'ACCEPTED',
            deletedAt: null,
            patient: { deletedAt: null },
            OR: ageScope,
            ...(scopes ? { acceptedLocationId: { in: scopes } } : {}),
            ...(input.cursor ? { id: { gt: input.cursor } } : {}),
            items: { some: pending },
          },
          orderBy: { id: 'asc' },
          take: limit + 1,
          include: {
            patient: {
              select: {
                firstName: true,
                lastName: true,
                phone: true,
              },
            },
            items: {
              where: pending,
              orderBy: [{ visit: 'asc' }, { id: 'asc' }],
            },
          },
        });
        const page = rows.slice(0, limit);
        const previous = page.length
          ? await tx.appointmentPlanItem.findMany({
              where: {
                deletedAt: null,
                planItem: { planId: { in: page.map((p) => p.id) } },
                appointment: { status: 'COMPLETED', deletedAt: null },
              },
              select: {
                planItem: { select: { planId: true, visit: true } },
                appointment: { select: { end: true } },
              },
            })
          : [];
        // Región del teléfono de la sede del plan, también si se retiró
        // (DX-329, P1, m17): nunca el país del paciente.
        const regions = new Map(
          (
            await tx.location.findMany({
              where: {
                id: {
                  in: page.flatMap((p) =>
                    p.acceptedLocationId ? [p.acceptedLocationId] : [],
                  ),
                },
              },
              select: { id: true, defaultPhoneRegion: true },
            })
          ).map((l) => [l.id, l.defaultPhoneRegion]),
        );
        const items = page.map((plan) => {
          const nextVisit = plan.items[0].visit;
          const completed = previous.filter(
            (l) =>
              l.planItem.planId === plan.id &&
              l.planItem.visit === nextVisit - 1,
          );
          const last = completed.length
            ? new Date(
                Math.max(...completed.map((l) => l.appointment.end.getTime())),
              )
            : null;
          const interval =
            (plan.visitIntervals as Record<string, number>)[
              String(nextVisit)
            ] ?? 0;
          return {
            planId: plan.id,
            patientId: plan.patientId,
            patientName:
              `${plan.patient.firstName} ${plan.patient.lastName}`.trim(),
            patientWhatsApp: whatsAppDigits(
              plan.patient.phone,
              regions.get(plan.acceptedLocationId ?? '') ?? null,
            ),
            optionLabel: plan.optionLabel,
            locationId: plan.acceptedLocationId,
            acceptedAt: plan.acceptedAt,
            daysSinceAccepted: Math.max(
              0,
              civilDaysInclusive(
                civilDateIn(plan.acceptedAt!, zoneOf(plan.acceptedLocationId!)),
                civilDateIn(now, zoneOf(plan.acceptedLocationId!)),
              ) - 1,
            ),
            currency: plan.currency,
            total:
              plan.items.reduce(
                (sum, i) =>
                  sum +
                  Math.round(
                    (i.price.toNumber() - i.discount.toNumber()) * 100,
                  ),
                0,
              ) / 100,
            itemCount: plan.items.length,
            nextVisit,
            visitLabel: plan.items[0].visitLabel,
            minimumDate: minimumVisitDate(
              last,
              interval,
              now,
              zoneOf(plan.acceptedLocationId!),
            ),
            minimumDay: civilDateIn(
              minimumVisitDate(
                last,
                interval,
                now,
                zoneOf(plan.acceptedLocationId!),
              ),
              zoneOf(plan.acceptedLocationId!),
            ),
            planItemIds: plan.items
              .filter((i) => i.visit === nextVisit)
              .map((i) => i.id),
          };
        });
        return {
          items,
          nextCursor: rows.length > limit ? page[page.length - 1].id : null,
          limit,
        };
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead },
    );
  }
}

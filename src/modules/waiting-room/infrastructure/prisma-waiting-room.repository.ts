import { Injectable } from '@nestjs/common';
import { AppointmentStatus, Prisma } from '@prisma/client';
import { PrismaService } from '../../../shared/prisma/prisma.service';
import { TenantContextService } from '../../../shared/tenancy/tenant-context.service';
import type {
  BoardRow,
  CreateWaitingRoomScreenRepoInput,
  ScreenForBoard,
  UpdateWaitingRoomScreenRepoInput,
  WaitingRoomRepository,
  WaitingRoomScreen,
} from '../domain/ports/waiting-room-repository.port';

/** Columnas de la pantalla que salen de la BD: NUNCA `tokenHash`. */
const SCREEN_SELECT = {
  id: true,
  locationId: true,
  name: true,
  nameMode: true,
  messages: true,
  soundEnabled: true,
  revokedAt: true,
  createdAt: true,
  updatedAt: true,
} satisfies Prisma.WaitingRoomScreenSelect;

type ScreenRow = Prisma.WaitingRoomScreenGetPayload<{
  select: typeof SCREEN_SELECT;
}>;

function toScreen(row: ScreenRow): WaitingRoomScreen {
  return { ...row, messages: row.messages ?? [] };
}

/** Estados del tablero: en la sala de espera o en el sillón. */
const BOARD_STATUSES = [AppointmentStatus.ARRIVED, AppointmentStatus.IN_CHAIR];

@Injectable()
export class PrismaWaitingRoomRepository implements WaitingRoomRepository {
  constructor(
    private readonly prisma: PrismaService,
    private readonly tenantContext: TenantContextService,
  ) {}

  /** El INSERT necesita el tenant explícito (sin default desde la GUC). */
  private requireTenantId(): string {
    const tenantId = this.tenantContext.getTenantId();
    if (!tenantId) throw new Error('No tenant in context');
    return tenantId;
  }

  list(params: { locationIds?: string[] }): Promise<WaitingRoomScreen[]> {
    return this.prisma.runWithTenant(async (tx) => {
      const rows = await tx.waitingRoomScreen.findMany({
        where: params.locationIds
          ? { locationId: { in: params.locationIds } }
          : {},
        select: SCREEN_SELECT,
        // Vivas primero (revokedAt NULL), luego por alta.
        orderBy: [
          { revokedAt: { sort: 'desc', nulls: 'first' } },
          { createdAt: 'asc' },
          { id: 'asc' },
        ],
      });
      return rows.map(toScreen);
    });
  }

  findById(id: string): Promise<WaitingRoomScreen | null> {
    return this.prisma.runWithTenant(async (tx) => {
      const row = await tx.waitingRoomScreen.findFirst({
        where: { id },
        select: SCREEN_SELECT,
      });
      return row ? toScreen(row) : null;
    });
  }

  create(input: CreateWaitingRoomScreenRepoInput): Promise<WaitingRoomScreen> {
    const tenantId = this.requireTenantId();
    return this.prisma.runWithTenant(async (tx) =>
      toScreen(
        await tx.waitingRoomScreen.create({
          data: {
            tenantId,
            locationId: input.locationId,
            name: input.name,
            tokenHash: input.tokenHash,
            nameMode: input.nameMode,
            messages: input.messages,
            soundEnabled: input.soundEnabled,
            createdById: input.createdById,
            updatedById: input.createdById,
          },
          select: SCREEN_SELECT,
        }),
      ),
    );
  }

  update(
    id: string,
    patch: UpdateWaitingRoomScreenRepoInput,
    actorId: string,
  ): Promise<WaitingRoomScreen | null> {
    return this.prisma.runWithTenant(async (tx) => {
      // Condición y cambio en la MISMA sentencia: si otra persona la revocó
      // entre la lectura y esto, no se escribe nada.
      const { count } = await tx.waitingRoomScreen.updateMany({
        where: { id, revokedAt: null },
        data: { ...patch, updatedById: actorId },
      });
      if (count === 0) return null;
      const row = await tx.waitingRoomScreen.findFirstOrThrow({
        where: { id },
        select: SCREEN_SELECT,
      });
      return toScreen(row);
    });
  }

  revoke(id: string, actorId: string): Promise<WaitingRoomScreen | null> {
    return this.prisma.runWithTenant(async (tx) => {
      await tx.waitingRoomScreen.updateMany({
        where: { id, revokedAt: null },
        data: {
          revokedAt: new Date(),
          revokedById: actorId,
          updatedById: actorId,
        },
      });
      const row = await tx.waitingRoomScreen.findFirst({
        where: { id },
        select: SCREEN_SELECT,
      });
      return row ? toScreen(row) : null;
    });
  }

  findForBoardByTokenHash(tokenHash: string): Promise<ScreenForBoard | null> {
    return this.prisma.runWithTenant(async (tx) => {
      // RLS: un hash de otra clínica es invisible (como uno inventado).
      const row = await tx.waitingRoomScreen.findFirst({
        where: { tokenHash },
        select: {
          ...SCREEN_SELECT,
          location: {
            select: {
              id: true,
              name: true,
              timeZone: true,
              locale: true,
              hourCycle: true,
              isActive: true,
              deletedAt: true,
            },
          },
        },
      });
      if (!row) return null;
      const { location, ...screen } = row;
      return {
        ...toScreen(screen),
        location: {
          id: location.id,
          name: location.name,
          timeZone: location.timeZone,
          locale: location.locale,
          hourCycle: location.hourCycle,
          live: location.isActive && location.deletedAt === null,
        },
      };
    });
  }

  boardRows(params: {
    locationId: string;
    from: Date;
    to: Date;
  }): Promise<BoardRow[]> {
    return this.prisma.runWithTenant(async (tx) => {
      // `appointments_tenant_location_in_clinic_idx` (parcial), como el panel
      // «En clínica». SOLO las columnas que el tablero puede mostrar.
      const rows = await tx.appointment.findMany({
        where: {
          locationId: params.locationId,
          deletedAt: null,
          status: { in: BOARD_STATUSES },
          start: { gte: params.from, lt: params.to },
        },
        orderBy: [{ start: 'asc' }, { id: 'asc' }],
        select: {
          id: true,
          status: true,
          providerId: true,
          start: true,
          arrivedAt: true,
          seatedAt: true,
          turnNumber: true,
          patient: { select: { firstName: true, lastName: true } },
          chair: { select: { name: true } },
        },
      });
      const providerIds = [...new Set(rows.map((r) => r.providerId))];
      // El nombre del profesional por su membresía (RLS: solo de esta
      // clínica), como el panel «En clínica».
      const memberships =
        providerIds.length === 0
          ? []
          : await tx.clinicMembership.findMany({
              where: { userId: { in: providerIds } },
              orderBy: { createdAt: 'desc' },
              select: { userId: true, user: { select: { fullName: true } } },
            });
      const names = new Map<string, string>();
      for (const m of memberships) {
        if (!names.has(m.userId)) names.set(m.userId, m.user.fullName);
      }
      return rows.map((r) => ({
        appointmentId: r.id,
        status: r.status,
        firstName: r.patient?.firstName ?? null,
        lastName: r.patient?.lastName ?? null,
        turnNumber: r.turnNumber,
        start: r.start,
        arrivedAt: r.arrivedAt,
        seatedAt: r.seatedAt,
        chairName: r.chair?.name ?? null,
        providerName: names.get(r.providerId) ?? null,
      }));
    });
  }
}

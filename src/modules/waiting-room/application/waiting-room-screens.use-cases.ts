import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { WaitingRoomNameMode } from '@prisma/client';
import {
  generatePublicLinkToken,
  hashPublicLinkToken,
} from '../../../shared/public-links/public-link-token';
import { TenantContextService } from '../../../shared/tenancy/tenant-context.service';
import { LOCATION_REPOSITORY } from '../../locations/domain/ports/location-repository.port';
import type { LocationRepository } from '../../locations/domain/ports/location-repository.port';
import {
  WAITING_ROOM_LOCATION_NOT_FOUND_MESSAGE,
  WAITING_ROOM_SCREEN_NOT_FOUND_MESSAGE,
  WAITING_ROOM_SCREEN_REVOKED_MESSAGE,
  normalizeScreenMessages,
  normalizeScreenName,
  screenMessagesError,
  screenNameError,
} from '../domain/waiting-room';
import {
  WAITING_ROOM_REPOSITORY,
  type UpdateWaitingRoomScreenRepoInput,
  type WaitingRoomRepository,
  type WaitingRoomScreen,
} from '../domain/ports/waiting-room-repository.port';

export interface CreateWaitingRoomScreenInput {
  locationId: string;
  name: string;
  nameMode?: WaitingRoomNameMode;
  messages?: string[];
  soundEnabled?: boolean;
}

export interface UpdateWaitingRoomScreenInput {
  name?: string;
  nameMode?: WaitingRoomNameMode;
  messages?: string[];
  soundEnabled?: boolean;
}

/** La pantalla recién creada y su token: la ÚNICA vez que sale entero. */
export interface CreatedWaitingRoomScreen extends WaitingRoomScreen {
  token: string;
}

function assertValid(error: string | null): void {
  if (error) throw new BadRequestException(error);
}

/**
 * DX-588: Ajustes › Pantallas de sala de espera (solo ADMIN; el rol lo pone
 * el controlador). Crear (el token se devuelve UNA vez; en la BD, su hash),
 * renombrar y ajustar el modo de nombre, los mensajes y el sonido, y revocar.
 * Una pantalla de una sede no permitida al usuario: 403 como el resto
 * (SEC-014). La auditoría de alta, cambios y revocación la pone `@Audit`.
 */
@Injectable()
export class WaitingRoomScreensUseCases {
  constructor(
    @Inject(WAITING_ROOM_REPOSITORY)
    private readonly repo: WaitingRoomRepository,
    @Inject(LOCATION_REPOSITORY)
    private readonly locations: LocationRepository,
    private readonly tenantContext: TenantContextService,
  ) {}

  list(locationId?: string): Promise<WaitingRoomScreen[]> {
    if (locationId) {
      this.tenantContext.assertLocationAllowed(locationId);
      return this.repo.list({ locationIds: [locationId] });
    }
    const allowed = this.tenantContext.getAllowedLocationIds();
    return this.repo.list(
      allowed === 'ALL' ? {} : { locationIds: [...allowed] },
    );
  }

  async create(
    input: CreateWaitingRoomScreenInput,
    actorId: string,
  ): Promise<CreatedWaitingRoomScreen> {
    this.tenantContext.assertLocationAllowed(input.locationId);
    const location = await this.locations.findById(input.locationId);
    if (!location || !location.isActive) {
      throw new NotFoundException(WAITING_ROOM_LOCATION_NOT_FOUND_MESSAGE);
    }
    assertValid(screenNameError(input.name));
    const messages = normalizeScreenMessages(input.messages ?? []);
    assertValid(screenMessagesError(messages));
    const token = generatePublicLinkToken();
    const screen = await this.repo.create({
      locationId: input.locationId,
      name: normalizeScreenName(input.name),
      tokenHash: hashPublicLinkToken(token),
      nameMode: input.nameMode ?? WaitingRoomNameMode.NAME_INITIAL,
      messages,
      soundEnabled: input.soundEnabled ?? false,
      createdById: actorId,
    });
    return { ...screen, token };
  }

  /** La pantalla de la clínica (RLS) en una sede permitida, o 404/403. */
  private async load(id: string): Promise<WaitingRoomScreen> {
    const screen = await this.repo.findById(id);
    if (!screen) {
      throw new NotFoundException(WAITING_ROOM_SCREEN_NOT_FOUND_MESSAGE);
    }
    this.tenantContext.assertLocationAllowed(screen.locationId);
    return screen;
  }

  async update(
    id: string,
    input: UpdateWaitingRoomScreenInput,
    actorId: string,
  ): Promise<WaitingRoomScreen> {
    const screen = await this.load(id);
    if (screen.revokedAt !== null) {
      throw new ConflictException(WAITING_ROOM_SCREEN_REVOKED_MESSAGE);
    }
    const patch: UpdateWaitingRoomScreenRepoInput = {};
    if (input.name !== undefined) {
      assertValid(screenNameError(input.name));
      patch.name = normalizeScreenName(input.name);
    }
    if (input.messages !== undefined) {
      const messages = normalizeScreenMessages(input.messages);
      assertValid(screenMessagesError(messages));
      patch.messages = messages;
    }
    if (input.nameMode !== undefined) patch.nameMode = input.nameMode;
    if (input.soundEnabled !== undefined) {
      patch.soundEnabled = input.soundEnabled;
    }
    const updated = await this.repo.update(id, patch, actorId);
    // Revocada entre la lectura y la escritura.
    if (!updated)
      throw new ConflictException(WAITING_ROOM_SCREEN_REVOKED_MESSAGE);
    return updated;
  }

  /** Idempotente: revocar una revocada la devuelve tal cual. */
  async revoke(id: string, actorId: string): Promise<WaitingRoomScreen> {
    await this.load(id);
    const revoked = await this.repo.revoke(id, actorId);
    if (!revoked) {
      throw new NotFoundException(WAITING_ROOM_SCREEN_NOT_FOUND_MESSAGE);
    }
    return revoked;
  }
}

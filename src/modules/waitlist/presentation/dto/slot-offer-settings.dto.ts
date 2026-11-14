import { ApiProperty } from '@nestjs/swagger';
import { IsInt, Max, Min } from 'class-validator';
import {
  SLOT_OFFER_EXPIRY_LEAD_MAX,
  SLOT_OFFER_EXPIRY_LEAD_MESSAGE,
  SLOT_OFFER_EXPIRY_LEAD_MIN,
  SLOT_OFFER_MIN_LEAD_MAX,
  SLOT_OFFER_MIN_LEAD_MESSAGE,
  SLOT_OFFER_MIN_LEAD_MIN,
} from '../../domain/slot-offer-link';

/** Lo que cambia el ADMIN (DX-448): igual en todas las sedes de la clínica. */
export class UpdateSlotOfferSettingsDto {
  @ApiProperty({
    minimum: SLOT_OFFER_EXPIRY_LEAD_MIN,
    maximum: SLOT_OFFER_EXPIRY_LEAD_MAX,
    example: 60,
    description:
      'Minutos antes del inicio del hueco en que caduca el enlace de la oferta (0 = al empezar el hueco). Cambiarlo no toca las ofertas ya enviadas.',
  })
  @IsInt({ message: SLOT_OFFER_EXPIRY_LEAD_MESSAGE })
  @Min(SLOT_OFFER_EXPIRY_LEAD_MIN, { message: SLOT_OFFER_EXPIRY_LEAD_MESSAGE })
  @Max(SLOT_OFFER_EXPIRY_LEAD_MAX, { message: SLOT_OFFER_EXPIRY_LEAD_MESSAGE })
  expiryLeadMinutes!: number;

  @ApiProperty({
    minimum: SLOT_OFFER_MIN_LEAD_MIN,
    maximum: SLOT_OFFER_MIN_LEAD_MAX,
    example: 20,
    description:
      'Vida mínima del enlace (minutos hasta que caduca) para poder ofrecer el hueco por enlace. 20 de plataforma.',
  })
  @IsInt({ message: SLOT_OFFER_MIN_LEAD_MESSAGE })
  @Min(SLOT_OFFER_MIN_LEAD_MIN, { message: SLOT_OFFER_MIN_LEAD_MESSAGE })
  @Max(SLOT_OFFER_MIN_LEAD_MAX, { message: SLOT_OFFER_MIN_LEAD_MESSAGE })
  minLeadMinutes!: number;
}

/** GET/PUT /slot-offer-settings. */
export class SlotOfferSettingsDto {
  @ApiProperty({
    example: 60,
    description:
      'Minutos antes del hueco en que caduca el enlace, ya resueltos: si la clínica no eligió, los de la instalación.',
  })
  expiryLeadMinutes!: number;

  @ApiProperty({
    example: 20,
    description:
      'Vida mínima del enlace para ofrecer el hueco por enlace (minutos).',
  })
  minLeadMinutes!: number;

  @ApiProperty({
    example: 0,
    description:
      'La caducidad anticipada de la instalación (`WAITLIST_LINK_OFFER_EXPIRY_LEAD_MINUTES`, 0 = al empezar): la que rige hasta que la clínica elige la suya.',
  })
  defaultExpiryLeadMinutes!: number;

  @ApiProperty({
    example: 20,
    description: 'La antelación mínima de plataforma.',
  })
  defaultMinLeadMinutes!: number;
}

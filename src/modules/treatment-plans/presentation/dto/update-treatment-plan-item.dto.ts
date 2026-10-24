import { ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsArray,
  IsEnum,
  IsISO8601,
  IsNumber,
  IsOptional,
  IsString,
  IsUUID,
  Min,
} from 'class-validator';
import { ToothSurface, TreatmentPlanItemStatus } from '@prisma/client';
import {
  IsMoney,
  MONEY_MAX,
} from '../../../../shared/validation/bounded-decimal';
import { DiscountReasonFieldsDto } from './discount-reason.dto';

// All fields optional (partial update: change price/status/surfaces/notes).
// NO `tenantId`/`planId` field — same rationale as UpdateAppointmentDto.
// `surfaces` reuses the odontogram's ToothSurface enum, not a new one.
export class UpdateTreatmentPlanItemDto extends DiscountReasonFieldsDto {
  @ApiPropertyOptional({
    description:
      'At most 2 decimal places. SEC-041: bajarlo por debajo del precio de catálogo del ítem cuenta como descuento (tope del rol y motivo); subirlo es libre',
    maximum: MONEY_MAX,
  })
  @IsOptional()
  @IsNumber()
  @Min(0)
  @IsMoney()
  price?: number;

  @ApiPropertyOptional({
    description:
      'Descuento (máx. 2 decimales); nunca mayor que el precio (400). DX-204: por encima del tope del rol de quien lo cambia, 403; en un plan aceptado (con o sin firma): 409',
    maximum: MONEY_MAX,
  })
  @IsOptional()
  @IsNumber()
  @Min(0)
  @IsMoney()
  discount?: number;

  @ApiPropertyOptional({
    enum: TreatmentPlanItemStatus,
    description:
      'DX-050: pasar a DONE guarda quién lo realizó (`performedById`), la sede del request (`X-Location-Id`) y `completedAt` (hora del servidor). Salir de DONE limpia los tres; solo ADMIN o quien lo realizó (403 si no), y queda auditado',
  })
  @IsOptional()
  @IsEnum(TreatmentPlanItemStatus)
  status?: TreatmentPlanItemStatus;

  @ApiPropertyOptional({
    format: 'uuid',
    description:
      'DX-050: usuario que realizó el procedimiento (miembro VIVO de esta clínica que atiende: DENTIST o ADMIN, y que atiende en la sede). Al pasar a DONE: por defecto quien marca si atiende; si no (ASSISTANT), obligatorio (400). Otra clínica o desactivado: 404. En un ítem ya DONE solo un ADMIN lo cambia (403), auditado',
  })
  @IsOptional()
  @IsUUID('all', { message: 'performedById debe ser un UUID.' })
  performedById?: string;

  @ApiPropertyOptional({
    format: 'date-time',
    description:
      'DX-050: SOLO para que un ADMIN corrija la fecha de un ítem ya DONE (403 a otro rol, 400 si es futura). Al pasar a DONE la pone el servidor (400 si llega)',
  })
  @IsOptional()
  @IsISO8601(
    { strict: true },
    { message: 'completedAt debe ser una fecha y hora ISO 8601.' },
  )
  completedAt?: string;

  @ApiPropertyOptional({
    format: 'uuid',
    description:
      'DX-305: SOLO para que un ADMIN corrija la sede donde se realizó un ítem ya DONE (403 a otro rol; 403 si no es de sus sedes permitidas, DX-089; 400 si no es de esta clínica). Obligatoria, junto con `performedById` y `completedAt`, al atribuir un ítem «Sin atribuir» (400 si falta alguno). Al pasar a DONE la pone la sede del request (400 si llega). Auditado con el antes y el después',
  })
  @IsOptional()
  @IsUUID('all', { message: 'performedLocationId debe ser un UUID.' })
  performedLocationId?: string;

  @ApiPropertyOptional({ enum: ToothSurface, isArray: true })
  @IsOptional()
  @IsArray()
  @IsEnum(ToothSurface, { each: true })
  surfaces?: ToothSurface[];

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  notes?: string;
}

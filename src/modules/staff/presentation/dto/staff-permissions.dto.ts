import { ApiProperty } from '@nestjs/swagger';
import { ExtraPermission } from '@prisma/client';
import { ArrayMaxSize, IsArray, IsEnum } from 'class-validator';

/** Respuesta de `PUT /staff/:userId/permissions` (DX-090). */
export class StaffPermissionsDto {
  @ApiProperty({
    enum: ExtraPermission,
    enumName: 'ExtraPermission',
    isArray: true,
    example: [ExtraPermission.PAYMENT_REGISTER],
    description:
      'Permisos extra concedidos al miembro, en el orden del catálogo',
  })
  extraPermissions!: ExtraPermission[];

  @ApiProperty({
    enum: ExtraPermission,
    enumName: 'ExtraPermission',
    isArray: true,
    example: [ExtraPermission.PAYMENT_REGISTER],
    description:
      'Lo que puede hacer en total: los de serie de su rol más los extra',
  })
  effectivePermissions!: ExtraPermission[];
}

/** Cuerpo de `PUT /staff/:userId/permissions` (DX-090). */
export class ReplaceStaffPermissionsDto {
  @ApiProperty({
    enum: ExtraPermission,
    enumName: 'ExtraPermission',
    isArray: true,
    maxItems: 2,
    example: [ExtraPermission.PAYMENT_REGISTER],
    description:
      'La lista COMPLETA de permisos extra (sustituye a la anterior). [] = ninguno. ' +
      'PAYMENT_REGISTER: registrar abonos y operar su turno de caja, sin anular. ' +
      'FINANCIAL_REPORTS_VIEW: ver los reportes financieros y la caja en lectura. ' +
      'Los duplicados se ignoran.',
  })
  @IsArray({ message: 'Los permisos van en una lista.' })
  @ArrayMaxSize(2, { message: 'Como mucho hay dos permisos extra.' })
  @IsEnum(ExtraPermission, {
    each: true,
    message: 'Algún permiso no existe en el catálogo.',
  })
  permissions!: ExtraPermission[];
}

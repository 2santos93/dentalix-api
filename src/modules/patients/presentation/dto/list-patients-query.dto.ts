import { ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  MaxLength,
  Min,
} from 'class-validator';
import {
  PATIENTS_MAX_PAGE,
  PATIENTS_MAX_PAGE_SIZE,
  PATIENTS_MAX_QUERY_LENGTH,
} from '../../application/use-cases/list-patients.use-case';

export class ListPatientsQueryDto {
  @ApiPropertyOptional({
    maxLength: PATIENTS_MAX_QUERY_LENGTH,
    description:
      'Búsqueda libre por nombre, apellido o documento (subcadena). Desde 2 ' +
      'caracteres no distingue tildes ni mayúsculas: "jose" encuentra "José".',
  })
  @IsOptional()
  @IsString({ message: 'La búsqueda debe ser un texto.' })
  @MaxLength(PATIENTS_MAX_QUERY_LENGTH, {
    message: `La búsqueda admite como mucho ${PATIENTS_MAX_QUERY_LENGTH} caracteres.`,
  })
  query?: string;

  @ApiPropertyOptional({
    format: 'uuid',
    description:
      'DX-153: solo pacientes con alguna cobertura viva de este pagador. Combinable con `query`. Un pagador de otra clínica da una lista vacía.',
  })
  @IsOptional()
  @IsUUID('4', { message: 'payerId debe ser un UUID.' })
  payerId?: string;

  @ApiPropertyOptional({
    minimum: 1,
    maximum: PATIENTS_MAX_PAGE,
    default: 1,
    description: `Tope: ${PATIENTS_MAX_PAGE} (un valor mayor responde 400). Para llegar más lejos, buscar.`,
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt({ message: 'page debe ser un número entero.' })
  @Min(1, { message: 'page empieza en 1.' })
  @Max(PATIENTS_MAX_PAGE, {
    message: `page admite hasta ${PATIENTS_MAX_PAGE}.`,
  })
  page?: number;

  @ApiPropertyOptional({
    minimum: 1,
    maximum: PATIENTS_MAX_PAGE_SIZE,
    default: 20,
    description: `Tope: ${PATIENTS_MAX_PAGE_SIZE} (un valor mayor se recorta; la respuesta trae el pageSize aplicado)`,
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt({ message: 'pageSize debe ser un número entero.' })
  @Min(1, { message: 'pageSize debe ser al menos 1.' })
  pageSize?: number;
}

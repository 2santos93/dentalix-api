import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsOptional,
  IsString,
  MaxLength,
  ValidateNested,
} from 'class-validator';
import { PrescriptionItemInputDto } from './prescription-item-input.dto';

export class PrescriptionTemplateItemDto {
  @ApiProperty() activeIngredient!: string;
  @ApiProperty({ type: String, nullable: true }) brandName!: string | null;
  @ApiProperty({ type: String, nullable: true }) concentration!: string | null;
  @ApiProperty({ type: String, nullable: true }) pharmaceuticalForm!:
    string | null;
  @ApiProperty({ type: String, nullable: true }) route!: string | null;
  @ApiProperty({ type: String, nullable: true }) dose!: string | null;
  @ApiProperty({ type: String, nullable: true }) frequency!: string | null;
  @ApiProperty({ type: Number, nullable: true }) durationDays!: number | null;
  @ApiProperty({ type: Number, nullable: true }) totalQuantity!: number | null;
  @ApiProperty({ type: String, nullable: true }) quantityUnit!: string | null;
  @ApiProperty({ type: Number, nullable: true }) packages!: number | null;
  @ApiProperty({ type: String, nullable: true }) instructions!: string | null;
}

export class PrescriptionTemplateDto {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty({ format: 'uuid' }) tenantId!: string;
  @ApiProperty() name!: string;
  @ApiProperty({ type: String, nullable: true }) notes!: string | null;
  @ApiProperty({ type: [PrescriptionTemplateItemDto] })
  items!: PrescriptionTemplateItemDto[];
  @ApiProperty({ format: 'date-time' }) createdAt!: Date;
  @ApiProperty({ format: 'date-time' }) updatedAt!: Date;
}

// Sin `tenantId`: sale del contexto del request. Solo el principio activo es
// obligatorio en cada medicamento; el resto se completa al emitir.
export class CreatePrescriptionTemplateDto {
  @ApiProperty({ minLength: 1, maxLength: 120, example: 'Post-exodoncia' })
  @IsString({ message: 'El nombre de la plantilla es obligatorio' })
  @MaxLength(120, { message: 'El nombre admite como mucho 120 caracteres' })
  name!: string;

  @ApiPropertyOptional({ maxLength: 1000 })
  @IsOptional()
  @IsString({ message: 'Las indicaciones deben ser un texto' })
  @MaxLength(1000, {
    message: 'Las indicaciones admiten como mucho 1000 caracteres',
  })
  notes?: string;

  @ApiProperty({ type: [PrescriptionItemInputDto] })
  @IsArray({ message: 'Los medicamentos deben ser una lista' })
  @ArrayMaxSize(10, {
    message: 'Una plantilla admite como mucho 10 medicamentos',
  })
  @ValidateNested({ each: true })
  @Type(() => PrescriptionItemInputDto)
  items!: PrescriptionItemInputDto[];
}

export class UpdatePrescriptionTemplateDto {
  @ApiPropertyOptional({ minLength: 1, maxLength: 120 })
  @IsOptional()
  @IsString({ message: 'El nombre de la plantilla es obligatorio' })
  @MaxLength(120, { message: 'El nombre admite como mucho 120 caracteres' })
  name?: string;

  @ApiPropertyOptional({ maxLength: 1000 })
  @IsOptional()
  @IsString({ message: 'Las indicaciones deben ser un texto' })
  @MaxLength(1000, {
    message: 'Las indicaciones admiten como mucho 1000 caracteres',
  })
  notes?: string;

  @ApiPropertyOptional({ type: [PrescriptionItemInputDto] })
  @IsOptional()
  @IsArray({ message: 'Los medicamentos deben ser una lista' })
  @ArrayMaxSize(10, {
    message: 'Una plantilla admite como mucho 10 medicamentos',
  })
  @ValidateNested({ each: true })
  @Type(() => PrescriptionItemInputDto)
  items?: PrescriptionItemInputDto[];
}

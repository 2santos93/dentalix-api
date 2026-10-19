import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsOptional, IsString, MaxLength } from 'class-validator';

export class Icd10CodeDto {
  @ApiProperty({ example: 'K02.1' })
  code!: string;

  @ApiProperty({ example: 'Caries de la dentina' })
  labelEs!: string;
}

export class SearchIcd10QueryDto {
  @ApiPropertyOptional({
    description:
      'Código (con o sin punto: «K02.1», «k021», «K02») o texto («caries»), sin distinguir tildes ni mayúsculas. Vacío: los primeros por código.',
    maxLength: 100,
  })
  @IsOptional()
  @IsString()
  @MaxLength(100, { message: 'La búsqueda admite como máximo 100 caracteres' })
  q?: string;
}

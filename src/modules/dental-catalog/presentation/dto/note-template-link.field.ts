import { applyDecorators } from '@nestjs/common';
import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsOptional, IsUUID } from 'class-validator';

/**
 * DX-455: `clinicalNoteTemplateId` de las altas y ediciones del catálogo.
 * null quita el vínculo (las evoluciones guardadas no cambian).
 */
export function NoteTemplateLinkField(): PropertyDecorator {
  return applyDecorators(
    ApiPropertyOptional({
      type: String,
      format: 'uuid',
      nullable: true,
      description:
        'DX-455: plantilla de evolución que se sugiere al marcar hecho el procedimiento; null = ninguna (quitarla no cambia las evoluciones guardadas). Debe ser de esta clínica (404) y estar activa (400); solo en procedimientos (400 en un diagnóstico).',
    }),
    IsOptional(),
    IsUUID('all', {
      message: 'La plantilla de evolución debe ser un id válido',
    }),
  );
}

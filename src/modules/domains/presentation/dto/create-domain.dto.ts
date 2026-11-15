import { ApiProperty } from '@nestjs/swagger';
import { Matches } from 'class-validator';

export class CreateDomainDto {
  @ApiProperty({
    example: 'citas.miclinica.com',
    description:
      'Dominio propio de la clínica (no un subdominio de la plataforma).',
  })
  // A dotted hostname: labels of alphanumerics/hyphens separated by dots.
  @Matches(/^(?=.{1,253}$)([a-z0-9]([a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,}$/i, {
    message:
      'El dominio no es válido: escribe un nombre como clinica.ejemplo.com.',
  })
  host!: string;
}

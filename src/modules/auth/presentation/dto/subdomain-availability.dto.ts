import { ApiProperty } from '@nestjs/swagger';
import {
  SUBDOMAIN_AVAILABILITY,
  type SubdomainAvailability,
} from '../../application/use-cases/check-subdomain-availability.use-case';

export class SubdomainAvailabilityDto {
  @ApiProperty({
    description:
      'La dirección tal como se registraría (sin espacios, en minúsculas). Vacía si la ruta era desmesurada.',
    example: 'sonrisa',
  })
  subdomain!: string;

  @ApiProperty({
    enum: SUBDOMAIN_AVAILABILITY,
    enumName: 'SubdomainAvailability',
    description:
      'available = se puede registrar; taken = ya es de una clínica (también dada de baja); invalid = no cumple el formato (minúsculas, números y guiones, 1–63, sin guion al principio ni al final); reserved = dirección de la plataforma (www, api…).',
  })
  status!: SubdomainAvailability;
}

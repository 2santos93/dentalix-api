import { ApiProperty } from '@nestjs/swagger';

export class PlatformTenantDto {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty({ example: 'Clínica Sonrisa' }) name!: string;
  @ApiProperty({
    example: 'sonrisa',
    description: 'Subdominio por el que se entra a la clínica',
  })
  subdomain!: string;
  @ApiProperty({ type: String, format: 'date-time' }) createdAt!: Date;
}

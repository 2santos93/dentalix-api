import { ApiProperty } from '@nestjs/swagger';

export const TENANT_DOMAIN_STATES = [
  'PENDING',
  'EXPIRED',
  'VERIFIED',
  'DISABLED',
] as const;

const STATE_DESCRIPTION =
  'PENDING: falta publicar o comprobar el TXT (72 h desde el alta). EXPIRED: el PENDING caducó o lo verificó otra cuenta; no se puede verificar, solo eliminar. VERIFIED: enruta. DISABLED: estuvo verificado pero la re-verificación periódica dejó de encontrar el TXT; no enruta y se puede volver a verificar.';

/** Un dominio personalizado de la clínica (SEC-009). */
export class TenantDomainDto {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty({ example: 'citas.miclinica.com' })
  host!: string;

  @ApiProperty({
    enum: TENANT_DOMAIN_STATES,
    enumName: 'TenantDomainState',
    description: STATE_DESCRIPTION,
  })
  status!: (typeof TENANT_DOMAIN_STATES)[number];

  @ApiProperty({ description: 'Valor del registro TXT de verificación.' })
  verifyToken!: string;

  @ApiProperty({ type: String, format: 'date-time', nullable: true })
  verifiedAt!: Date | null;

  @ApiProperty({
    type: String,
    format: 'date-time',
    nullable: true,
    description:
      'Hasta cuándo se puede verificar un PENDING. null si ya se verificó.',
  })
  expiresAt!: Date | null;

  @ApiProperty({
    type: String,
    format: 'date-time',
    nullable: true,
    description: 'Última re-verificación periódica.',
  })
  lastCheckedAt!: Date | null;

  @ApiProperty({
    description:
      'Re-verificaciones fallidas seguidas (se reinicia al encontrar el TXT).',
  })
  failedChecks!: number;

  @ApiProperty({ type: String, format: 'date-time', nullable: true })
  disabledAt!: Date | null;

  @ApiProperty({ format: 'date-time' })
  createdAt!: Date;
}

export class DomainDnsRecordDto {
  @ApiProperty({ example: '_dentalix-verify.citas.miclinica.com' })
  name!: string;

  @ApiProperty({ enum: ['TXT'] })
  type!: 'TXT';

  @ApiProperty()
  value!: string;
}

export class RegisterDomainResponseDto {
  @ApiProperty({ type: TenantDomainDto })
  domain!: TenantDomainDto;

  @ApiProperty({ type: DomainDnsRecordDto })
  dns!: DomainDnsRecordDto;
}

export class VerifyDomainResponseDto {
  @ApiProperty({
    enum: TENANT_DOMAIN_STATES,
    enumName: 'TenantDomainState',
    description: STATE_DESCRIPTION,
  })
  status!: (typeof TENANT_DOMAIN_STATES)[number];
}

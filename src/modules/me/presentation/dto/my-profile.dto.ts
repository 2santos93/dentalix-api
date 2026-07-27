import { ApiProperty } from '@nestjs/swagger';
import { ClinicRole } from '@prisma/client';

export class MyProfileMembershipDto {
  @ApiProperty() tenantId!: string;
  @ApiProperty() clinicName!: string;
  @ApiProperty({ enum: ClinicRole }) role!: ClinicRole;
}

export class MyProfileDto {
  @ApiProperty() id!: string;
  @ApiProperty() email!: string;
  @ApiProperty() fullName!: string;
  @ApiProperty({ type: String, nullable: true }) avatarUrl!: string | null;
  @ApiProperty({ type: String, nullable: true }) emailVerifiedAt!: string | null;
  @ApiProperty({ type: [MyProfileMembershipDto] }) memberships!: MyProfileMembershipDto[];
}

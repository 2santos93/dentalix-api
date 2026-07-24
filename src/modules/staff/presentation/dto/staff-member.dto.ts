import { ApiProperty } from '@nestjs/swagger';
import { ClinicRole } from '@prisma/client';

// Response shape for GET /staff — documents the `{userId, fullName, email, role}`
// contract for Swagger. The use case/repository already return values
// shaped exactly like this (StaffMember entity); this class exists purely
// for `@ApiProperty` documentation, not for input validation.
export class StaffMemberDto {
  @ApiProperty({ format: 'uuid' })
  userId!: string;

  @ApiProperty()
  fullName!: string;

  @ApiProperty()
  email!: string;

  @ApiProperty({ enum: ClinicRole })
  role!: ClinicRole;
}

import { ApiProperty } from '@nestjs/swagger';

export class AvatarResponseDto {
  @ApiProperty({
    description:
      'URL absoluta y estable del avatar (FILES_PUBLIC_BASE_URL vigente + clave)',
  })
  avatarUrl!: string;
}

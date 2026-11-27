import { Body, Param } from '@nestjs/common';
import { PartialType } from '@nestjs/swagger';
import { IsOptional, IsString } from 'class-validator';
import { auditBodyDtoFields } from './audit-body-dto';

class BaseDto {
  @IsString()
  firstName!: string;

  @IsOptional()
  @IsString()
  phone?: string;
}

class PatchDto extends PartialType(BaseDto) {
  @IsOptional()
  @IsString()
  notes?: string;
}

class Controller {
  update(@Param('id') _id: string, @Body() _dto: PatchDto): void {}

  byField(@Body('phone') _phone: string): void {}

  plain(@Body() _body: Record<string, unknown>): void {}

  noBody(@Param('id') _id: string): void {}
}

// El handler de la ruta solo se lee por su nombre (el del método).
describe('auditBodyDtoFields (DX-095)', () => {
  it('los campos que el DTO del cuerpo declara (también los heredados de PartialType)', () => {
    const fields = auditBodyDtoFields(Controller, { name: 'update' });
    expect(fields).not.toBeNull();
    expect([...(fields ?? [])].sort()).toEqual(['firstName', 'notes', 'phone']);
  });

  it('null si no hay un DTO de clase para el cuerpo entero (no se puede cruzar)', () => {
    expect(auditBodyDtoFields(Controller, { name: 'byField' })).toBe(null);
    expect(auditBodyDtoFields(Controller, { name: 'plain' })).toBe(null);
    expect(auditBodyDtoFields(Controller, { name: 'noBody' })).toBe(null);
  });
});

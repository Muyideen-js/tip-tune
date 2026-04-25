import {
  IsString,
  IsNumber,
  IsPositive,
  IsIn,
  IsOptional,
  Length,
  Matches,
  IsUUID,
} from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class CreatePayoutDto {
  @ApiProperty({ description: 'Artist ID requesting the payout' })
  @IsUUID()
  artistId: string;

  @ApiProperty({ description: 'Amount to withdraw', example: 50 })
  @IsNumber({ maxDecimalPlaces: 7 })
  @IsPositive()
  amount: number;

  @ApiProperty({ description: 'Asset code', enum: ['XLM', 'USDC'], example: 'XLM' })
  @IsString()
  @IsIn(['XLM', 'USDC'])
  assetCode: 'XLM' | 'USDC';

  @ApiProperty({
    description: 'Stellar destination address (must be owned by artist)',
    example: 'GAAZI4TCR3TY5OJHCTJC2A4QSY6CJWJH5IAJTGKIN2ER7LBNVKOCCWN',
  })
  @IsString()
  @Length(56, 56)
  @Matches(/^G[A-Z2-7]{55}$/, { message: 'Invalid Stellar address format' })
  destinationAddress: string;

  @ApiPropertyOptional({
    description:
      'Client-generated idempotency key (UUID v4 recommended). ' +
      'Retrying with the same key returns the original result without creating a duplicate.',
    example: '7f3e8d2a-1b4c-4f5e-9a0b-2c3d4e5f6a7b',
  })
  @IsOptional()
  @IsString()
  @Length(1, 128)
  idempotencyKey?: string;
}

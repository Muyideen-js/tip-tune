import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Adds an idempotencyKey column to payout_requests for replay-safe retries.
 *
 * The column is nullable so existing rows are not affected.
 * A unique index ensures duplicate keys are rejected at the DB level as a
 * last line of defence even if the application-level check is bypassed.
 */
export class AddPayoutIdempotencyKey1771000001000 implements MigrationInterface {
  name = 'AddPayoutIdempotencyKey1771000001000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "payout_requests"
      ADD COLUMN IF NOT EXISTS "idempotencyKey" character varying(128) DEFAULT NULL
    `);

    await queryRunner.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS "UQ_payout_requests_idempotencyKey"
      ON "payout_requests" ("idempotencyKey")
      WHERE "idempotencyKey" IS NOT NULL
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      DROP INDEX IF EXISTS "UQ_payout_requests_idempotencyKey"
    `);

    await queryRunner.query(`
      ALTER TABLE "payout_requests"
      DROP COLUMN IF EXISTS "idempotencyKey"
    `);
  }
}

import type { Knex } from 'knex';

/**
 * TOTP anti-replay.
 *
 * users.totp_last_step = last TOTP time step (floor(unix / 30)) accepted for
 * the user. twoFactorService.acceptTotpStep() accepts a code only when its
 * step is newer than this value and stores it in the same atomic UPDATE, so a
 * code can never be used twice (sign-in, factor management).
 *
 * Nullable, no backfill: NULL means "no code used yet". Idempotent.
 */
export async function up(knex: Knex): Promise<void> {
  if (!(await knex.schema.hasColumn('users', 'totp_last_step'))) {
    await knex.schema.alterTable('users', (t) => {
      t.bigInteger('totp_last_step').nullable();
    });
  }
}

export async function down(knex: Knex): Promise<void> {
  if (await knex.schema.hasColumn('users', 'totp_last_step')) {
    await knex.schema.alterTable('users', (t) => {
      t.dropColumn('totp_last_step');
    });
  }
}

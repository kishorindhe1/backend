'use strict';

/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface, Sequelize) {
    // ── 1. patient_doctor_durations ───────────────────────────────────────────
    await queryInterface.sequelize.query(`
      CREATE TABLE IF NOT EXISTS patient_doctor_durations (
        id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        patient_id       UUID NOT NULL REFERENCES users(id),
        doctor_id        UUID NOT NULL REFERENCES doctor_profiles(id),
        duration_minutes INTEGER NOT NULL,
        set_by_user_id   UUID NOT NULL REFERENCES users(id),
        set_by_role      VARCHAR(20) NOT NULL CHECK (set_by_role IN ('doctor','receptionist')),
        set_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
        notes            TEXT,
        created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
        updated_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
        UNIQUE (patient_id, doctor_id)
      );
      CREATE INDEX IF NOT EXISTS idx_pdd_patient_doctor ON patient_doctor_durations (patient_id, doctor_id);
      CREATE INDEX IF NOT EXISTS idx_pdd_doctor ON patient_doctor_durations (doctor_id);
    `);

    // ── 2. patient_doctor_duration_history ────────────────────────────────────
    await queryInterface.sequelize.query(`
      CREATE TABLE IF NOT EXISTS patient_doctor_duration_history (
        id                          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        patient_doctor_duration_id  UUID NOT NULL REFERENCES patient_doctor_durations(id),
        old_duration                INTEGER NOT NULL,
        new_duration                INTEGER NOT NULL,
        changed_by_user_id          UUID NOT NULL REFERENCES users(id),
        changed_by_role             VARCHAR(20) NOT NULL,
        changed_at                  TIMESTAMPTZ NOT NULL DEFAULT now(),
        reason                      TEXT,
        created_at                  TIMESTAMPTZ NOT NULL DEFAULT now(),
        updated_at                  TIMESTAMPTZ NOT NULL DEFAULT now()
      );
      CREATE INDEX IF NOT EXISTS idx_pddh_pdd_id ON patient_doctor_duration_history (patient_doctor_duration_id);
    `);

    // ── 3. Add lunch break + booking config to doctor_profiles ────────────────
    await queryInterface.sequelize.query(`
      DO $$
      BEGIN
        IF NOT EXISTS (
          SELECT 1 FROM information_schema.columns
          WHERE table_name = 'doctor_profiles' AND column_name = 'break_type'
        ) THEN
          CREATE TYPE "enum_doctor_profiles_break_type" AS ENUM ('split_session', 'flexible');
          ALTER TABLE doctor_profiles
            ADD COLUMN break_type               "enum_doctor_profiles_break_type" DEFAULT 'flexible',
            ADD COLUMN morning_end              TIME,
            ADD COLUMN afternoon_start          TIME,
            ADD COLUMN break_window_start       TIME,
            ADD COLUMN break_window_end         TIME,
            ADD COLUMN buffer_time_minutes      INTEGER NOT NULL DEFAULT 0,
            ADD COLUMN walkin_qr_enabled        BOOLEAN NOT NULL DEFAULT false,
            ADD COLUMN waitlist_enabled         BOOLEAN NOT NULL DEFAULT true,
            ADD COLUMN waitlist_offer_expiry_minutes INTEGER NOT NULL DEFAULT 30;
        END IF;
      END $$;
    `);

    // ── 4. Add duration snapshot columns to opd_tokens ────────────────────────
    await queryInterface.sequelize.query(`
      DO $$
      BEGIN
        IF NOT EXISTS (
          SELECT 1 FROM information_schema.columns
          WHERE table_name = 'opd_tokens' AND column_name = 'personalized_duration_minutes'
        ) THEN
          ALTER TABLE opd_tokens
            ADD COLUMN personalized_duration_minutes INTEGER,
            ADD COLUMN duration_override             INTEGER;
        END IF;
      END $$;
    `);
  },

  async down(queryInterface, Sequelize) {
    await queryInterface.sequelize.query(`
      ALTER TABLE opd_tokens
        DROP COLUMN IF EXISTS personalized_duration_minutes,
        DROP COLUMN IF EXISTS duration_override;
    `);
    await queryInterface.sequelize.query(`
      ALTER TABLE doctor_profiles
        DROP COLUMN IF EXISTS break_type,
        DROP COLUMN IF EXISTS morning_end,
        DROP COLUMN IF EXISTS afternoon_start,
        DROP COLUMN IF EXISTS break_window_start,
        DROP COLUMN IF EXISTS break_window_end,
        DROP COLUMN IF EXISTS buffer_time_minutes,
        DROP COLUMN IF EXISTS walkin_qr_enabled,
        DROP COLUMN IF EXISTS waitlist_enabled,
        DROP COLUMN IF EXISTS waitlist_offer_expiry_minutes;
      DROP TYPE IF EXISTS "enum_doctor_profiles_break_type";
    `);
    await queryInterface.dropTable('patient_doctor_duration_history');
    await queryInterface.dropTable('patient_doctor_durations');
  },
};

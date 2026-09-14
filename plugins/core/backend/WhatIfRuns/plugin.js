const router = require("./routes/whatifRuns");
const { sequelize } = require("./models/whatif_run");
const logger = require("../../../../API/logger");

let setup = {
  //Once the app initializes
  onceInit: (s) => {
    s.app.use(
      s.ROOT_PATH + "/api/whatif-runs",
      s.ensureUser(),
      s.checkHeadersCodeInjection,
      s.setContentType,
      router
    );
  },
  //Once the server starts
  onceStarted: (s) => {},
  //Once all tables sync
  onceSynced: (s) => {
    // `sequelize.sync()` creates whatif_runs but never adds columns or indexes
    // to an existing table, so bring older databases up to date. All statements
    // use IF NOT EXISTS, so this is a no-op once the schema is current.
    const migrations = [
      'ALTER TABLE "whatif_runs" ADD COLUMN IF NOT EXISTS "result" JSONB;',
      'ALTER TABLE "whatif_runs" ADD COLUMN IF NOT EXISTS "user_id" VARCHAR(255);',
      'CREATE INDEX IF NOT EXISTS "whatif_runs_user_id" ON "whatif_runs" ("user_id");',
    ];
    migrations.forEach((sql) => {
      sequelize.query(sql).catch((err) => {
        logger(
          "error",
          "Failed to migrate whatif_runs schema.",
          "WhatIfRuns",
          null,
          err
        );
      });
    });
  },
};

module.exports = setup;

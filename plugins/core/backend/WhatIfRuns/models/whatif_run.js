/***********************************************************
 * Loading all required dependencies, libraries and packages
 **********************************************************/
const Sequelize = require("sequelize");
const { sequelize } = require("../../../../../API/connection");
require("dotenv").config();

// Persisted run history for the WildfireWhatIf tool. Rows are scoped by
// `user_id` (the Keycloak `sub` claim, a stable per-user UUID); `username`
// is kept alongside as a human-readable label only. Rows with a null
// user_id belong to callers that don't send one.
var WhatIfRun = sequelize.define(
  "whatif_runs",
  {
    scenario_id: {
      type: Sequelize.STRING,
      unique: true,
      allowNull: false,
    },
    endpoint: {
      type: Sequelize.STRING(2048),
      allowNull: true,
    },
    name: {
      type: Sequelize.STRING(1024),
      allowNull: true,
      defaultValue: "",
    },
    payload: {
      type: Sequelize.JSONB,
      allowNull: true,
    },
    // Generated forecast output frozen at submission time (the buildPayloadResult
    // object plus the predicted spreadRing). Kept separate from `payload` (the
    // inputs) so a saved run reloads exactly the prediction the user saw.
    result: {
      type: Sequelize.JSONB,
      allowNull: true,
    },
    // Keycloak `sub` — the canonical key runs are scoped by.
    user_id: {
      type: Sequelize.STRING,
      allowNull: true,
    },
    // Denormalized display label; not used for scoping.
    username: {
      type: Sequelize.STRING,
      allowNull: true,
    },
  },
  {
    timestamps: true,
    createdAt: "created_on",
    updatedAt: "updated_on",
    indexes: [
      {
        fields: ["user_id"],
      },
      {
        fields: ["username"],
      },
    ],
  }
);

module.exports = { WhatIfRun, sequelize };

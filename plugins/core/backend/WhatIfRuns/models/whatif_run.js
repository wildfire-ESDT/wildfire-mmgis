/***********************************************************
 * Loading all required dependencies, libraries and packages
 **********************************************************/
const Sequelize = require("sequelize");
const { sequelize } = require("../../../../../API/connection");
require("dotenv").config();

// Persisted run history for the WildfireWhatIf tool. Rows are scoped by
// `username` (the tool's logged-in Keycloak user); rows with a null
// username belong to callers that don't send one.
var WhatIfRun = sequelize.define(
  "whatif_runs",
  {
    workflow_id: {
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
        fields: ["username"],
      },
    ],
  }
);

module.exports = { WhatIfRun, sequelize };

/***********************************************************
 * JavaScript syntax format: ES5/ES6 - ECMAScript 2015
 * Loading all required dependencies, libraries and packages
 **********************************************************/
const express = require("express");
const router = express.Router();

const logger = require("../../../../../API/logger");
const wr = require("../models/whatif_run");
const WhatIfRun = wr.WhatIfRun;

// Every route acts as req.whatIfUser, the caller verified from their Keycloak
// access token (see ../keycloakAccess.js). Another user's run answers as not
// found, so its existence isn't revealed.

/**
 * Lists the caller's run history rows, newest first.
 */
router.get("/", function (req, res) {
  WhatIfRun.findAll({
    where: { user_id: req.whatIfUser.id },
    order: [["created_on", "DESC"]],
  })
    .then((rows) => {
      res.send({
        status: "success",
        message: "Successfully fetched run history.",
        body: rows,
      });
    })
    .catch((err) => {
      logger("error", "Failed to fetch run history.", "WhatIfRuns", null, err);
      res.status(500).send({
        status: "failure",
        message: "Failed to fetch run history.",
        body: [],
      });
    });
});

/**
 * Upserts one of the caller's runs by scenario_id. Only fields present in the
 * body are updated, so a rename POST of {scenario_id, name} keeps the
 * original payload/endpoint.
 */
router.post("/", function (req, res) {
  const b = req.body || {};
  if (b.scenario_id == null || b.scenario_id === "") {
    res.status(400).send({
      status: "failure",
      message: "scenario_id is required.",
      body: {},
    });
    return;
  }

  // Owner fields come from the verified caller, never from the body.
  const fields = { username: req.whatIfUser.username };
  if (b.endpoint !== undefined) fields.endpoint = b.endpoint;
  if (b.name !== undefined) fields.name = b.name;
  if (b.payload !== undefined) fields.payload = b.payload;
  if (b.result !== undefined) fields.result = b.result;

  WhatIfRun.findOne({ where: { scenario_id: String(b.scenario_id) } })
    .then((existing) => {
      if (existing && existing.user_id !== req.whatIfUser.id) return null;
      if (existing) return existing.update(fields);
      return WhatIfRun.create({
        scenario_id: String(b.scenario_id),
        ...fields,
        user_id: req.whatIfUser.id,
      });
    })
    .then((row) => {
      if (!row) {
        res.status(404).send({
          status: "failure",
          message: "Run not found.",
          body: {},
        });
        return;
      }
      res.send({
        status: "success",
        message: "Successfully saved run.",
        body: row,
      });
    })
    .catch((err) => {
      logger("error", "Failed to save run.", "WhatIfRuns", null, err);
      res.status(500).send({
        status: "failure",
        message: "Failed to save run.",
        body: {},
      });
    });
});

/**
 * Deletes one of the caller's runs by scenario_id.
 */
router.delete("/:scenario_id", function (req, res) {
  const scenario_id = req.params.scenario_id;
  if (!scenario_id) {
    return res.status(400).send({
      status: "failure",
      message: "scenario_id is required.",
      body: {},
    });
  }
  WhatIfRun.destroy({ where: { scenario_id, user_id: req.whatIfUser.id } })
    .then((count) => {
      if (count === 0) {
        return res.status(404).send({
          status: "failure",
          message: "Run not found.",
          body: {},
        });
      }
      res.send({
        status: "success",
        message: "Successfully deleted run.",
        body: { scenario_id },
      });
    })
    .catch((err) => {
      logger("error", "Failed to delete run.", "WhatIfRuns", null, err);
      res.status(500).send({
        status: "failure",
        message: "Failed to delete run.",
        body: {},
      });
    });
});

module.exports = router;

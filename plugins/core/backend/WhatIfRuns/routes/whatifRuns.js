/***********************************************************
 * JavaScript syntax format: ES5/ES6 - ECMAScript 2015
 * Loading all required dependencies, libraries and packages
 **********************************************************/
const express = require("express");
const router = express.Router();

const logger = require("../../../../../API/logger");
const wr = require("../models/whatif_run");
const WhatIfRun = wr.WhatIfRun;

/**
 * Lists run history rows, newest first, scoped to one user.
 * @query user_id *optional* Only rows recorded under this Keycloak `sub`.
 *   Falls back to `username` for legacy callers. Without either, only rows
 *   recorded with no user_id are returned.
 */
router.get("/", function (req, res) {
  let where;
  if (req.query.user_id != null && req.query.user_id !== "") {
    where = { user_id: String(req.query.user_id) };
  } else if (req.query.username != null && req.query.username !== "") {
    where = { username: String(req.query.username) };
  } else {
    where = { user_id: null };
  }
  WhatIfRun.findAll({
    where,
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
 * Upserts a run history row by scenario_id. Only fields present in the
 * body are updated, so a rename POST of {scenario_id, name} keeps the
 * original payload/endpoint/username.
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

  const fields = {};
  if (b.endpoint !== undefined) fields.endpoint = b.endpoint;
  if (b.name !== undefined) fields.name = b.name;
  if (b.payload !== undefined) fields.payload = b.payload;
  if (b.result !== undefined) fields.result = b.result;
  if (b.user_id !== undefined) fields.user_id = b.user_id;
  if (b.username !== undefined) fields.username = b.username;

  WhatIfRun.findOne({ where: { scenario_id: b.scenario_id } })
    .then((existing) => {
      if (existing) return existing.update(fields);
      return WhatIfRun.create({ scenario_id: b.scenario_id, ...fields });
    })
    .then((row) => {
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
 * Deletes a single run by scenario_id.
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
  WhatIfRun.destroy({ where: { scenario_id } })
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

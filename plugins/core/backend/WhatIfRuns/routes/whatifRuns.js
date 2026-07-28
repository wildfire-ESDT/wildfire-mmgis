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
 * Lists run history rows, newest first.
 * @query username *optional* Only rows recorded under this username.
 *   Without it, only rows recorded with no username are returned.
 */
router.get("/", function (req, res) {
  const where =
    req.query.username != null && req.query.username !== ""
      ? { username: String(req.query.username) }
      : { username: null };
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
 * Upserts a run history row by workflow_id. Only fields present in the
 * body are updated, so a rename POST of {workflow_id, name} keeps the
 * original payload/endpoint/username.
 */
router.post("/", function (req, res) {
  const b = req.body || {};
  if (b.workflow_id == null || b.workflow_id === "") {
    res.status(400).send({
      status: "failure",
      message: "workflow_id is required.",
      body: {},
    });
    return;
  }

  const fields = {};
  if (b.endpoint !== undefined) fields.endpoint = b.endpoint;
  if (b.name !== undefined) fields.name = b.name;
  if (b.payload !== undefined) fields.payload = b.payload;
  if (b.username !== undefined) fields.username = b.username;

  WhatIfRun.findOne({ where: { workflow_id: b.workflow_id } })
    .then((existing) => {
      if (existing) return existing.update(fields);
      return WhatIfRun.create({ workflow_id: b.workflow_id, ...fields });
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

module.exports = router;

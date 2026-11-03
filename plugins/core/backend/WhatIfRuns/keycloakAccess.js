/***********************************************************
 * Who is calling the run history routes, from their Keycloak
 * access token. The token must be signed (RS256) by a key the
 * realm publishes, issued by WHATIF_KEYCLOAK_ISSUER for the
 * WHATIF_KEYCLOAK_CLIENT_ID client, and not expired. Identity
 * never comes from the request body or query.
 **********************************************************/
const crypto = require("crypto");
const logger = require("../../../../API/logger");

const ACCESS_TOKEN_HEADER = "X-WhatIf-Access-Token";
// An unknown key id refetches the realm's keys (they rotate), but at most this often.
const KEYS_REFETCH_COOLDOWN_MS = 60 * 1000;
const CLOCK_SKEW_SECONDS = 30;

let publicKeysById = new Map();
let keysFetchedAt = 0;
let keysBeingFetched = null;
let hasLoggedMissingIssuer = false;

function configuredIssuer() {
  return (process.env.WHATIF_KEYCLOAK_ISSUER || "").replace(/\/$/, "");
}

async function fetchRealmKeys() {
  keysFetchedAt = Date.now();
  const response = await fetch(
    `${configuredIssuer()}/protocol/openid-connect/certs`
  );
  if (!response.ok)
    throw new Error(`Keycloak keys request failed: HTTP ${response.status}`);
  const { keys } = await response.json();
  publicKeysById = new Map(
    (keys || [])
      .filter((key) => key.kty === "RSA" && key.use === "sig" && key.kid)
      .map((key) => [key.kid, crypto.createPublicKey({ key, format: "jwk" })])
  );
}

async function publicKeyFor(keyId) {
  if (!publicKeysById.has(keyId)) {
    if (Date.now() - keysFetchedAt < KEYS_REFETCH_COOLDOWN_MS) return null;
    keysBeingFetched =
      keysBeingFetched ||
      fetchRealmKeys().finally(() => {
        keysBeingFetched = null;
      });
    await keysBeingFetched;
  }
  return publicKeysById.get(keyId) || null;
}

function decodeJsonPart(encodedPart) {
  try {
    return JSON.parse(Buffer.from(encodedPart, "base64url").toString("utf8"));
  } catch (error) {
    return null;
  }
}

/** The token's claims when it is a valid access token from the realm, else null. */
async function verifiedAccessTokenClaims(accessToken) {
  if (typeof accessToken !== "string") return null;
  const tokenParts = accessToken.split(".");
  if (tokenParts.length !== 3) return null;
  const [encodedHeader, encodedClaims, encodedSignature] = tokenParts;
  const header = decodeJsonPart(encodedHeader);
  const claims = decodeJsonPart(encodedClaims);
  if (!header || !claims || header.alg !== "RS256" || !header.kid) return null;

  const publicKey = await publicKeyFor(header.kid);
  if (!publicKey) return null;
  const isSignedByRealm = crypto.verify(
    "sha256",
    Buffer.from(`${encodedHeader}.${encodedClaims}`),
    publicKey,
    Buffer.from(encodedSignature, "base64url")
  );
  if (!isSignedByRealm) return null;

  const nowSeconds = Math.floor(Date.now() / 1000);
  const expectedClientId = process.env.WHATIF_KEYCLOAK_CLIENT_ID;
  if (claims.iss !== configuredIssuer()) return null;
  // Keycloak marks access tokens "Bearer"; ID and refresh tokens are refused.
  if (claims.typ !== "Bearer") return null;
  if (expectedClientId && claims.azp !== expectedClientId) return null;
  if (typeof claims.exp !== "number" || claims.exp + CLOCK_SKEW_SECONDS < nowSeconds)
    return null;
  if (typeof claims.nbf === "number" && claims.nbf - CLOCK_SKEW_SECONDS > nowSeconds)
    return null;
  if (typeof claims.sub !== "string" || claims.sub === "") return null;
  return claims;
}

/** Express middleware: sets req.whatIfUser from a valid token, or answers 401. */
function requireWhatIfUser(req, res, next) {
  if (!configuredIssuer()) {
    if (!hasLoggedMissingIssuer)
      logger(
        "error",
        "WHATIF_KEYCLOAK_ISSUER is not set, so run history can't tell who is calling.",
        "WhatIfRuns"
      );
    hasLoggedMissingIssuer = true;
    res.status(503).send({
      status: "failure",
      message: "Run history is not configured on this server.",
      body: {},
    });
    return;
  }
  verifiedAccessTokenClaims(req.get(ACCESS_TOKEN_HEADER))
    .then((claims) => {
      if (!claims) {
        res.status(401).send({
          status: "failure",
          message: "Sign in to use run history.",
          body: {},
        });
        return;
      }
      req.whatIfUser = {
        id: claims.sub,
        username: claims.preferred_username || null,
      };
      next();
    })
    .catch((err) => {
      logger("error", "Could not verify a run history caller.", "WhatIfRuns", null, err);
      res.status(503).send({
        status: "failure",
        message: "Could not reach the sign-in server.",
        body: {},
      });
    });
}

module.exports = {
  ACCESS_TOKEN_HEADER,
  requireWhatIfUser,
  verifiedAccessTokenClaims,
};

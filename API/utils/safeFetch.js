/**
 * Safe Fetch Wrapper - Wraps node-fetch to block requests to internal IPs
 * Prevents SSRF attacks by validating URLs before making HTTP requests
 */

const fetch = require('node-fetch');
const { validateUrl } = require('./ipBlocker');
const logger = require('../logger');

/**
 * Safe fetch wrapper that validates URLs before making requests
 * @param {string} url - The URL to fetch
 * @param {Object} options - Fetch options
 * @param {Object} validationOptions - Validation options
 * @param {boolean} validationOptions.skipValidation - Skip IP validation (use with caution)
 * @param {boolean} validationOptions.allowLocalhost - Allow localhost addresses
 * @param {boolean} validationOptions.resolveHostname - Resolve hostnames to IPs
 * @returns {Promise} - Fetch promise
 */
async function safeFetch(url, options = {}, validationOptions = {}) {
  const {
    skipValidation = false,
    allowLocalhost = false,
    resolveHostname = true,
  } = validationOptions;

  // Skip validation if explicitly disabled (for internal service calls)
  if (skipValidation === true) {
    return fetch(url, options);
  }

  // Validate URL before making request
  const validation = await validateUrl(url, { allowLocalhost, resolveHostname });

  if (!validation.isValid) {
    const error = new Error(`Blocked request to internal IP: ${validation.reason}`);
    error.code = 'SSRF_BLOCKED';
    error.url = url;
    error.reason = validation.reason;

    logger(
      'warn',
      `safeFetch blocked request - URL: ${url}, Reason: ${validation.reason}`,
      'safeFetch'
    );

    throw error;
  }

  // URL is safe, proceed with fetch
  return fetch(url, options);
}

/**
 * Create a safe fetch instance with default validation options
 * @param {Object} defaultValidationOptions - Default validation options
 * @returns {Function} - Safe fetch function with default options
 */
function createSafeFetch(defaultValidationOptions = {}) {
  return (url, options = {}, validationOptions = {}) => {
    const mergedValidationOptions = {
      ...defaultValidationOptions,
      ...validationOptions,
    };
    return safeFetch(url, options, mergedValidationOptions);
  };
}

module.exports = safeFetch;
module.exports.createSafeFetch = createSafeFetch;

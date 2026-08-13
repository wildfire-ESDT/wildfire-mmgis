/**
 * IP Blocker Utility - Blocks requests to internal/private IP addresses
 * Prevents SSRF attacks by validating URLs and IP addresses
 */

const dns = require('dns').promises;
const { URL } = require('url');
const logger = require('../logger');

// Private IP ranges to block
const PRIVATE_IP_RANGES = [
  // IPv4 ranges
  { start: '10.0.0.0', end: '10.255.255.255', cidr: '10.0.0.0/8' },
  { start: '172.16.0.0', end: '172.31.255.255', cidr: '172.16.0.0/12' },
  { start: '192.168.0.0', end: '192.168.255.255', cidr: '192.168.0.0/16' },
  { start: '127.0.0.0', end: '127.255.255.255', cidr: '127.0.0.0/8' },
  { start: '169.254.0.0', end: '169.254.255.255', cidr: '169.254.0.0/16' },
  { start: '0.0.0.0', end: '0.255.255.255', cidr: '0.0.0.0/8' },
  { start: '100.64.0.0', end: '100.127.255.255', cidr: '100.64.0.0/10' }, // Carrier-grade NAT
  { start: '192.0.0.0', end: '192.0.0.255', cidr: '192.0.0.0/24' }, // IETF Protocol Assignments
  { start: '192.0.2.0', end: '192.0.2.255', cidr: '192.0.2.0/24' }, // TEST-NET-1
  { start: '198.18.0.0', end: '198.19.255.255', cidr: '198.18.0.0/15' }, // Benchmark testing
  { start: '198.51.100.0', end: '198.51.100.255', cidr: '198.51.100.0/24' }, // TEST-NET-2
  { start: '203.0.113.0', end: '203.0.113.255', cidr: '203.0.113.0/24' }, // TEST-NET-3
  { start: '224.0.0.0', end: '239.255.255.255', cidr: '224.0.0.0/4' }, // Multicast
  { start: '240.0.0.0', end: '255.255.255.255', cidr: '240.0.0.0/4' }, // Reserved
];

// Private IPv6 ranges
const PRIVATE_IPV6_RANGES = [
  '::1/128', // localhost
  '::/128', // unspecified
  'fc00::/7', // unique local addresses
  'fe80::/10', // link-local
  'ff00::/8', // multicast
  '::ffff:0:0/96', // IPv4-mapped IPv6
];

// Localhost/loopback patterns
const LOCALHOST_PATTERNS = [
  'localhost',
  'localhost.localdomain',
  '*.local',
];

/**
 * Convert IP address string to number
 */
function ipToNumber(ip) {
  const parts = ip.split('.');
  if (parts.length !== 4) return null;

  return parts.reduce((acc, part, index) => {
    const num = parseInt(part, 10);
    if (isNaN(num) || num < 0 || num > 255) return null;
    return acc + (num << (24 - index * 8));
  }, 0);
}

/**
 * Check if an IP is within a range
 */
function isIpInRange(ip, startIp, endIp) {
  const ipNum = ipToNumber(ip);
  const startNum = ipToNumber(startIp);
  const endNum = ipToNumber(endIp);

  if (ipNum === null || startNum === null || endNum === null) return false;

  return ipNum >= startNum && ipNum <= endNum;
}

/**
 * Check if an IPv4 address is private/internal
 */
function isPrivateIPv4(ip) {
  for (const range of PRIVATE_IP_RANGES) {
    if (isIpInRange(ip, range.start, range.end)) {
      return true;
    }
  }
  return false;
}

/**
 * Check if an IPv6 address is private/internal
 */
function isPrivateIPv6(ip) {
  // Simplified IPv6 check - in production, use a library like 'ip' or 'ipaddr.js'
  const lowercaseIp = ip.toLowerCase();

  // Check for localhost
  if (lowercaseIp === '::1' || lowercaseIp === '0:0:0:0:0:0:0:1') return true;

  // Check for link-local (fe80::/10)
  if (lowercaseIp.startsWith('fe80:')) return true;

  // Check for unique local addresses (fc00::/7)
  if (lowercaseIp.startsWith('fc') || lowercaseIp.startsWith('fd')) return true;

  // Check for multicast (ff00::/8)
  if (lowercaseIp.startsWith('ff')) return true;

  // Check for IPv4-mapped IPv6 addresses (::ffff:x.x.x.x)
  if (lowercaseIp.includes('::ffff:')) {
    const ipv4Part = lowercaseIp.split('::ffff:')[1];
    if (ipv4Part) {
      // Try to extract and check the IPv4 part
      const ipv4Match = ipv4Part.match(/(\d+\.\d+\.\d+\.\d+)/);
      if (ipv4Match) {
        return isPrivateIPv4(ipv4Match[1]);
      }
    }
  }

  return false;
}

/**
 * Normalize different IP encodings to standard dotted decimal
 */
function normalizeIP(input) {
  const normalized = [];

  // Remove whitespace
  input = input.trim();

  // Check for standard IPv4 format
  if (/^\d+\.\d+\.\d+\.\d+$/.test(input)) {
    normalized.push(input);
  }

  // Check for decimal encoding (e.g., 2130706433 for 127.0.0.1)
  if (/^\d+$/.test(input)) {
    const num = parseInt(input, 10);
    if (num >= 0 && num <= 4294967295) {
      const ip = [
        (num >>> 24) & 0xff,
        (num >>> 16) & 0xff,
        (num >>> 8) & 0xff,
        num & 0xff,
      ].join('.');
      normalized.push(ip);
    }
  }

  // Check for hexadecimal encoding (e.g., 0x7f000001 for 127.0.0.1)
  if (/^0x[0-9a-f]+$/i.test(input)) {
    const num = parseInt(input, 16);
    if (num >= 0 && num <= 4294967295) {
      const ip = [
        (num >>> 24) & 0xff,
        (num >>> 16) & 0xff,
        (num >>> 8) & 0xff,
        num & 0xff,
      ].join('.');
      normalized.push(ip);
    }
  }

  // Check for octal encoding (e.g., 0177.0.0.1)
  if (/^0[0-7]+(\.[0-9]+)*$/.test(input) || /^\d+\.\d+\.\d+\.0[0-7]+$/.test(input)) {
    const parts = input.split('.');
    const convertedParts = parts.map(part => {
      if (part.startsWith('0') && part.length > 1 && /^[0-7]+$/.test(part)) {
        return parseInt(part, 8);
      }
      return parseInt(part, 10);
    });

    if (convertedParts.length === 4 && convertedParts.every(p => p >= 0 && p <= 255)) {
      normalized.push(convertedParts.join('.'));
    }
  }

  // Check for mixed encodings (e.g., 127.0x0.0.1)
  const mixedMatch = input.match(/^(\d+|0x[0-9a-f]+|0[0-7]+)\.(\d+|0x[0-9a-f]+|0[0-7]+)\.(\d+|0x[0-9a-f]+|0[0-7]+)\.(\d+|0x[0-9a-f]+|0[0-7]+)$/i);
  if (mixedMatch) {
    const parts = [mixedMatch[1], mixedMatch[2], mixedMatch[3], mixedMatch[4]];
    const convertedParts = parts.map(part => {
      if (part.startsWith('0x')) return parseInt(part, 16);
      if (part.startsWith('0') && part.length > 1) return parseInt(part, 8);
      return parseInt(part, 10);
    });

    if (convertedParts.every(p => p >= 0 && p <= 255)) {
      normalized.push(convertedParts.join('.'));
    }
  }

  return normalized;
}

/**
 * Check if a hostname matches localhost patterns
 */
function isLocalhostHostname(hostname) {
  const lower = hostname.toLowerCase();

  for (const pattern of LOCALHOST_PATTERNS) {
    if (pattern.startsWith('*')) {
      const suffix = pattern.substring(1);
      if (lower.endsWith(suffix)) return true;
    } else if (lower === pattern) {
      return true;
    }
  }

  return false;
}

/**
 * Validate if a URL is safe (not pointing to internal resources)
 * @param {string} urlString - The URL to validate
 * @param {Object} options - Options for validation
 * @param {boolean} options.resolveHostname - Whether to resolve hostname to IP (default: true)
 * @param {boolean} options.allowLocalhost - Whether to allow localhost (default: false)
 * @returns {Promise<{isValid: boolean, reason?: string, resolvedIps?: string[]}>}
 */
async function validateUrl(urlString, options = {}) {
  const { resolveHostname = true, allowLocalhost = false } = options;

  try {
    // Parse URL
    let parsedUrl;
    try {
      parsedUrl = new URL(urlString);
    } catch (e) {
      return { isValid: false, reason: 'Invalid URL format' };
    }

    const hostname = parsedUrl.hostname;

    // Only validate HTTP/HTTPS protocols
    if (!['http:', 'https:'].includes(parsedUrl.protocol)) {
      return { isValid: false, reason: `Unsupported protocol: ${parsedUrl.protocol}` };
    }

    // Check for localhost hostname patterns
    if (!allowLocalhost && isLocalhostHostname(hostname)) {
      return { isValid: false, reason: 'Localhost hostnames are not allowed' };
    }

    // Check if hostname is an IP address
    const ipv4Regex = /^(\d+\.){3}\d+$/;
    const ipv6Regex = /^\[?([0-9a-f:]+)\]?$/i;

    let ipsToCheck = [];

    if (ipv4Regex.test(hostname)) {
      // Direct IPv4 address
      ipsToCheck.push(hostname);

      // Also check alternate encodings
      const normalized = normalizeIP(hostname);
      ipsToCheck.push(...normalized);
    } else if (ipv6Regex.test(hostname)) {
      // Direct IPv6 address
      const ipv6 = hostname.replace(/[\[\]]/g, '');
      ipsToCheck.push(ipv6);
    } else {
      // Check for encoded IPs in hostname
      const normalized = normalizeIP(hostname);
      if (normalized.length > 0) {
        ipsToCheck.push(...normalized);
      }

      // Resolve hostname to IP addresses
      if (resolveHostname) {
        try {
          const addresses = await dns.resolve4(hostname).catch(() => []);
          const addresses6 = await dns.resolve6(hostname).catch(() => []);
          ipsToCheck.push(...addresses, ...addresses6);
        } catch (e) {
          // DNS resolution failed - might be external or might not exist
          // We'll allow it to proceed but log the failure
          logger('warn', `DNS resolution failed for ${hostname}: ${e.message}`, 'ipBlocker');
        }
      }
    }

    // Check all IPs
    for (const ip of ipsToCheck) {
      // Check IPv4
      if (ipv4Regex.test(ip)) {
        if (isPrivateIPv4(ip)) {
          return {
            isValid: false,
            reason: `Private/internal IPv4 address detected: ${ip}`,
            resolvedIps: ipsToCheck
          };
        }
      }

      // Check IPv6
      if (ipv6Regex.test(ip) || ip.includes(':')) {
        if (isPrivateIPv6(ip)) {
          return {
            isValid: false,
            reason: `Private/internal IPv6 address detected: ${ip}`,
            resolvedIps: ipsToCheck
          };
        }
      }
    }

    return { isValid: true, resolvedIps: ipsToCheck };
  } catch (error) {
    logger('error', `Error validating URL ${urlString}: ${error.message}`, 'ipBlocker');
    return { isValid: false, reason: `Validation error: ${error.message}` };
  }
}

/**
 * Express middleware to block requests with internal IPs in URL parameters
 */
function createIpBlockingMiddleware(options = {}) {
  const { paramNames = ['url', 'callback', 'redirect', 'target'], logBlocked = true } = options;

  return async (req, res, next) => {
    try {
      // Check query parameters
      for (const paramName of paramNames) {
        const paramValue = req.query[paramName] || req.body?.[paramName];

        if (paramValue && typeof paramValue === 'string') {
          // Try to parse as URL
          if (paramValue.startsWith('http://') || paramValue.startsWith('https://')) {
            const validation = await validateUrl(paramValue, { resolveHostname: false });

            if (!validation.isValid) {
              if (logBlocked) {
                logger(
                  'warn',
                  `Blocked request to internal IP - Parameter: ${paramName}, URL: ${paramValue}, Reason: ${validation.reason}`,
                  req.originalUrl,
                  req
                );
              }

              return res.status(403).json({
                status: 'error',
                message: 'Access to internal/private IP addresses is not allowed',
                reason: validation.reason
              });
            }
          }
        }
      }

      next();
    } catch (error) {
      logger('error', `Error in IP blocking middleware: ${error.message}`, req.originalUrl, req);
      // Fail securely - block the request
      return res.status(500).json({
        status: 'error',
        message: 'Error validating request'
      });
    }
  };
}

module.exports = {
  validateUrl,
  isPrivateIPv4,
  isPrivateIPv6,
  normalizeIP,
  createIpBlockingMiddleware,
};

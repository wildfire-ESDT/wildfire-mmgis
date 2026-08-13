# SSRF Protection Implementation

## Overview

This document describes the Server-Side Request Forgery (SSRF) protection implementation added to MMGIS to prevent unauthorized access to internal IP addresses and services.

## What is SSRF?

Server-Side Request Forgery (SSRF) is a vulnerability that allows an attacker to induce the server to make HTTP requests to arbitrary domains, including internal IP addresses. This can lead to:

- Unauthorized access to internal services
- Data exfiltration from internal networks
- Port scanning of internal infrastructure
- Access to cloud instance metadata (e.g., EC2 metadata at 169.254.169.254)

## Implementation

### 1. IP Blocker Utility (`API/utils/ipBlocker.js`)

A comprehensive utility that:

- **Detects private/internal IP ranges:**
  - 10.0.0.0/8
  - 172.16.0.0/12
  - 192.168.0.0/16
  - 127.0.0.0/8 (localhost)
  - 169.254.0.0/16 (link-local/AWS metadata)
  - And other reserved ranges

- **Blocks alternate IP encodings:**
  - Decimal notation (e.g., 2130706433 → 127.0.0.1)
  - Hexadecimal notation (e.g., 0x7f000001 → 127.0.0.1)
  - Octal notation (e.g., 0177.0.0.1 → 127.0.0.1)
  - Mixed encodings (e.g., 127.0x0.0.1 → 127.0.0.1)
  - IPv6-mapped IPv4 addresses (e.g., ::ffff:127.0.0.1)

- **Resolves hostnames:**
  - DNS resolution to detect if a domain resolves to internal IPs
  - Prevents DNS rebinding attacks

### 2. Safe Fetch Wrapper (`API/utils/safeFetch.js`)

A wrapper around `node-fetch` that:

- Validates all URLs before making HTTP requests
- Blocks requests to internal IPs
- Can be configured to skip validation for trusted internal services
- Provides clear error messages when requests are blocked

**Usage:**

```javascript
const safeFetch = require('../API/utils/safeFetch');

// External URL - will be validated
safeFetch('https://example.com/api')
  .then(res => res.json())
  .catch(err => console.error(err));

// Internal trusted service - skip validation
safeFetch('http://localhost:8881/api', {}, { skipValidation: true })
  .then(res => res.json());

// Allow localhost but validate for other internal IPs
safeFetch('http://localhost:8080/api', {}, { allowLocalhost: true })
  .then(res => res.json());
```

### 3. Express Middleware

Added to `scripts/server.js` to check URL parameters in incoming requests:

```javascript
app.use(createIpBlockingMiddleware({
  paramNames: ['url', 'callback', 'redirect', 'target', 'webhook', 'proxy'],
  logBlocked: true
}));
```

This middleware automatically blocks requests where URL parameters contain internal IPs.

### 4. Updated Components

#### Webhooks (`API/Backend/Webhooks/processes/triggerwebhooks.js`)
- Now uses `safeFetch` to validate webhook URLs
- Prevents webhooks from targeting internal services

#### STAC API (`API/Backend/Stac/routes/stac.js`)
- Uses `safeFetch` with `skipValidation: true` for internal STAC service calls
- Internal service is trusted as it's part of the application stack

#### SPICE Kernels (`spice/getKernels.js`)
- Uses `safeFetch` with configurable validation
- Set `SPICE_SKIP_URL_VALIDATION=true` in `.env` if downloading from trusted internal sources

#### TiTiler Proxy (`adjacent-servers/validateTitilerUrl.js`)
- Enhanced with IP validation in addition to existing pattern matching
- Validates URLs before proxying to TiTiler service

## Configuration

### Environment Variables

Add these to your `.env` file:

```bash
# Skip URL validation for SPICE kernel downloads (use only for trusted sources)
SPICE_SKIP_URL_VALIDATION=false

# TiTiler URL pattern validation (existing)
# If not set or set to [], all URLs are allowed (after IP validation)
# If set to array of regex patterns, only matching URLs are allowed
TITILER_ALLOWED_URL_PATTERNS='["^https://example\\.com/.*", "^s3://.*"]'
```

## Testing

### Test Cases

1. **Block localhost/loopback:**
   ```bash
   curl "http://localhost:8888/api/endpoint?url=http://localhost"
   curl "http://localhost:8888/api/endpoint?url=http://127.0.0.1"
   ```
   Expected: 403 Forbidden

2. **Block link-local (AWS metadata):**
   ```bash
   curl "http://localhost:8888/api/endpoint?url=http://169.254.169.254/latest/meta-data"
   ```
   Expected: 403 Forbidden

3. **Block private IPs:**
   ```bash
   curl "http://localhost:8888/api/endpoint?url=http://10.0.0.1"
   curl "http://localhost:8888/api/endpoint?url=http://172.16.0.1"
   curl "http://localhost:8888/api/endpoint?url=http://192.168.1.1"
   ```
   Expected: 403 Forbidden

4. **Block alternate encodings:**
   ```bash
   # Decimal encoding of 127.0.0.1
   curl "http://localhost:8888/api/endpoint?url=http://2130706433"

   # Hex encoding of 127.0.0.1
   curl "http://localhost:8888/api/endpoint?url=http://0x7f000001"

   # Octal encoding
   curl "http://localhost:8888/api/endpoint?url=http://0177.0.0.1"
   ```
   Expected: 403 Forbidden

5. **Allow external URLs:**
   ```bash
   curl "http://localhost:8888/api/endpoint?url=https://api.github.com"
   ```
   Expected: Request processed normally

### Manual Testing

1. **Webhook Testing:**
   - Try to create a webhook with URL: `http://localhost:8080/test`
   - Should be blocked with error message

2. **TiTiler Testing:**
   - Try to access: `/titiler/cog/info?url=http://169.254.169.254/`
   - Should be blocked with 403 Forbidden

## Security Considerations

### Defense in Depth

This implementation provides multiple layers of defense:

1. **Input validation** - Express middleware checks URL parameters
2. **DNS resolution** - Resolves hostnames to detect internal IPs
3. **Encoding detection** - Normalizes alternate IP encodings
4. **Application-level validation** - safeFetch validates before requests

### Limitations

- **DNS Rebinding:** While we resolve hostnames, time-of-check-time-of-use (TOCTOU) issues could occur if DNS changes between validation and request. Consider implementing caching or TTL-based validation for critical paths.

- **IPv6:** IPv6 validation is simplified. For production, consider using a library like `ipaddr.js` for comprehensive IPv6 support.

- **Subdomain enumeration:** Attackers might try to register domains that resolve to internal IPs. The DNS resolution helps mitigate this.

### Bypass Prevention

Common bypass techniques that are mitigated:

1. ✅ **Decimal/Hex/Octal encoding** - Normalized before validation
2. ✅ **IPv6 localhost** - Checked for ::1 and other IPv6 internal ranges
3. ✅ **DNS tricks** - Resolved before validation
4. ✅ **Localhost aliases** - Pattern matching for .local domains
5. ✅ **URL parser confusion** - Using Node.js built-in URL parser

## Logging

All blocked requests are logged with:
- URL that was blocked
- Reason for blocking
- Request details (IP, user agent, etc.)

Check logs for security monitoring:

```bash
# Docker logs
docker logs mmgis | grep "Blocked request to internal IP"

# Application logs
tail -f logs/mmgis.log | grep "ipBlocker"
```

## Compliance

This implementation helps meet security requirements for:

- **OWASP Top 10** - A10:2021 – Server-Side Request Forgery (SSRF)
- **CWE-918** - Server-Side Request Forgery
- **NIST** - Network segmentation and access control
- **PCI DSS** - Requirement 6.5.1 (Injection flaws)

## Deployment

### Docker

The protection is enabled by default when the application starts. No additional Docker configuration is needed.

### EC2 Instance

For EC2 deployments:

1. This protection complements (not replaces) AWS security groups
2. Keep security groups configured to restrict outbound access
3. Use VPC endpoints for AWS services when possible
4. Monitor CloudWatch logs for blocked requests

### Updates

When updating MMGIS:

1. Review `.env` for new environment variables
2. Test webhook URLs after updates
3. Verify internal service communication still works
4. Check logs for any false positives

## Troubleshooting

### Internal Services Not Working

If legitimate internal service calls are being blocked:

**For STAC, TiTiler, etc.:**
- These should already use `skipValidation: true`
- Check logs for specific error messages

**For SPICE kernels:**
- Set `SPICE_SKIP_URL_VALIDATION=true` in `.env`
- Only use this for trusted kernel sources

**For custom webhooks:**
- Webhooks to internal services are intentionally blocked
- Use external webhook endpoints instead
- Or modify the code to add specific allowlist

### DNS Resolution Failures

If DNS resolution is slow or failing:

- The system will log warnings but allow requests to proceed
- Consider setting up local DNS caching
- For containers, ensure proper DNS configuration in Docker

### False Positives

If legitimate URLs are being blocked:

1. Check if the domain resolves to an internal IP
2. Review logs for the specific reason
3. If needed, add domain-specific handling in `ipBlocker.js`

## Contact

For security issues or questions:

1. Check logs for detailed error messages
2. Review this documentation
3. Open an issue on GitHub with security tag
4. For sensitive issues, contact the security team directly

## References

- [OWASP SSRF Prevention Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/Server_Side_Request_Forgery_Prevention_Cheat_Sheet.html)
- [AWS EC2 Instance Metadata](https://docs.aws.amazon.com/AWSEC2/latest/UserGuide/ec2-instance-metadata.html)
- [CWE-918: Server-Side Request Forgery](https://cwe.mitre.org/data/definitions/918.html)

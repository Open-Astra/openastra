# Security Policy

## Supported Versions

Open Astra is pre-1.0. Security fixes land on `main` and ship in the next tagged release. Only the latest minor release line is supported.

| Version | Supported |
|---------|-----------|
| 0.1.x   | Yes       |
| < 0.1   | No        |

## Reporting a Vulnerability

**Please do not open a public issue, discussion, or pull request for a security problem.**

Report it privately through GitHub's private vulnerability reporting:

1. Go to the [Security tab](https://github.com/Open-Astra/openastra/security) of this repository.
2. Click **Report a vulnerability**.
3. Include what you can of the following:
   - Affected component (gateway route, tool, channel, memory tier, inference adapter, etc.) and version or commit SHA
   - Deployment mode (`npx astra`, Docker Compose, standalone CLI, or server)
   - Steps to reproduce or a proof of concept
   - Impact as you understand it (for example cross-workspace data access, auth bypass, SSRF, sandbox escape, or prompt-injection-to-tool-execution)

### What to expect

- **Acknowledgement** within 3 business days.
- **Initial assessment** (confirmed, needs more information, or not a vulnerability) within 10 business days.
- **Fix and disclosure**: we aim to release a fix within 90 days of the report, sooner for critical issues. We will coordinate the disclosure date with you and publish a GitHub Security Advisory, crediting you unless you ask us not to.

## Scope

In scope:

- Code in this repository: gateway, agent loop, tools, skills, channels, memory, inference adapters, dashboard, Helm chart, and Docker and k8s manifests
- Default configurations shipped in `astra.yml`, `docker-compose.yml`, and `helm/`

Out of scope:

- Vulnerabilities in third-party LLM providers or upstream dependencies (report those upstream; tell us if Open Astra's use of them makes things worse)
- Issues that require an already-compromised host, a malicious operator, or admin credentials
- Model output quality, or jailbreaks that do not cross a trust boundary (for example reaching a tool, data, or workspace the caller is not authorized for)
- Denial of service through volumetric traffic

## Threat Model

The trust boundaries, assets, and mitigations this policy is measured against are documented in [`src/security/THREAT_MODEL.md`](src/security/THREAT_MODEL.md).

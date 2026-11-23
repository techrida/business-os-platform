# Security policy

## Supported versions

Security fixes are applied to the `main` branch. Older snapshots and unmaintained feature branches do not receive security backports.

| Version                   | Supported |
| ------------------------- | --------- |
| `main`                    | Yes       |
| Older commits or branches | No        |

## Reporting a vulnerability

Do not open a public GitHub issue, pull request, or discussion for a suspected security vulnerability.

Report vulnerabilities privately through GitHub Private Vulnerability Reporting on this repository:

1. Open the **Security** tab on `https://github.com/techrida/business-os-platform`.
2. Select **Advisories** and click **Report a vulnerability**.

Include enough detail to reproduce and evaluate the issue:

- Affected application, endpoint, or package (for example `apps/api`, `apps/workspace`, `apps/portal`, or `infra/`).
- Step-by-step reproduction instructions or a minimal proof of concept.
- Potential impact (such as cross-tenant data access, authorization bypass, or secret exposure).
- Any suggested mitigation or patch, if you have one.

## Response expectations

Business OS is maintained by Techrida on a best-effort basis. We aim to acknowledge private vulnerability reports within 5 business days and share an initial assessment once we reproduce the finding. There is currently no formal SLA or bug bounty program.

Please allow reasonable time to investigate, prepare a fix, and notify affected self-hosted operators before disclosing details publicly.

## Out of scope

The following items are not treated as security vulnerabilities:

- Placeholder secrets in `.env.example`, which exist only for local development and are replaced by `infra/scripts/make-dev-env.sh`.
- Local development tooling (such as the dev-only account switcher or Mailpit), provided those routes and tools are excluded from production builds and images. If you find a way for dev tooling to appear or execute in a production build, please report it as a vulnerability.
- Denial-of-service reports that rely solely on saturating an unprotected single-host development setup.

# Security policy

## Supported versions

ScaleFlow is pre-1.0. Security fixes are made on `main` only.

## Reporting a vulnerability

Please **do not open a public issue**. Report privately through GitHub's
"Report a vulnerability" button on the repository's **Security** tab (private security advisories).

Include what you found, how to reproduce it (requests, payloads, configuration), the impact you
expect, and the commit you tested. Redact real API keys and personal data.

What to expect:

- Acknowledgement within 5 working days.
- An assessment and, if confirmed, a fix or mitigation plan within 30 days, coordinated with you.
- Credit in the release notes if you want it.

## Scope

In scope: the API, workers, relay, scheduler, dashboard, Docker images and default configuration in
this repository. Particularly interesting: tenant isolation (accessing another project's jobs, events
or streams), authentication and API-key handling, SSRF through webhook jobs, injection, and leaks of
secrets or payloads through logs or errors.

Out of scope: denial of service by raw traffic volume, findings that require a compromised host or
database, and the known limitations listed in [docs/security.md](docs/security.md) (for example the
absence of MFA or email verification).

The current security model and what has been tested are documented in
[docs/security.md](docs/security.md).

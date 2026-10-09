# Security policy

## Reporting a vulnerability

Please do not open a public issue for a security problem. Report it privately with GitHub's private
vulnerability reporting for this repository (Security tab, then "Report a vulnerability"). If that option
is not available, contact the repository owner directly.

Include the affected component (backend or mobile), the steps to reproduce, and the expected impact.

## Scope and deployment notes

- Access tokens are bearer secrets. Deploy the backend only behind HTTPS.
- Rate limiting is not part of the application. Configure it at the reverse proxy
  ([backend/README.md](backend/README.md#deployment-requirements)).
- Set `AUDIOBOOK_ENVIRONMENT=production` and `AUDIOBOOK_API_KEY`. In production the server refuses to start
  with the fake speech provider.
- The offline voice model is downloaded over HTTPS. Set `VOSK_MODEL_SHA256` to pin the archive
  (see [mobile/README.md](mobile/README.md)).
- `npm audit` reports 54 findings from four advisories, all in build, test and development tooling. None is in the
  app bundle. See [docs/PLAN_REVIEW.md](docs/PLAN_REVIEW.md#4-open-items). Do not run `npm audit fix --force`,
  because it can break the pinned Expo versions.

## Supported versions

The project is pre-release (0.1.0). Security fixes are made on the default branch.

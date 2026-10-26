# Contributing

Thanks for your interest in the AEE SDK.

## Licence

This project is licensed under the Apache License 2.0. By submitting a contribution you agree that it is licensed under the same terms (inbound equals outbound). See [LICENSE](./LICENSE).

## Support expectations

This project is maintained on a best-effort basis. Issues and pull requests are welcome, but there are no guaranteed response times and no guarantee that a given change will be accepted.

## Before you open a pull request

1. Open an issue first for anything larger than a small fix, so the direction can be agreed.
2. Keep changes focused and add tests alongside them.
3. Run the suites for the package you changed:
   - TypeScript: `cd typescript && npm ci && npm run build && npm test`
   - Python: `cd python && pip install -e ".[dev]" && pytest`
4. Do not include real hostnames, IP addresses, credentials or customer data in code, fixtures or documentation. Use fictional values such as `host-01` and `203.0.113.x`.

## Reporting security issues

Do not use public issues for vulnerabilities. See [SECURITY.md](./SECURITY.md).

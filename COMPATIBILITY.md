# Compatibility

## Target platform

This SDK targets **QuoxCORE 4.x**. Envelopes produced by the SDK conform to the AEE v1 schema vendored under `conformance/`.

## Versioning policy

The SDK follows semantic versioning in intent:

- **Patch releases** fix bugs and do not change public behaviour.
- **Minor releases** add backwards-compatible features and may add optional envelope fields.
- **Major releases** may change public APIs or the envelope contract, and will be noted in the release notes.

Versions before 1.0 may change between minor releases. See [STATUS_AND_LIMITS.md](./STATUS_AND_LIMITS.md) for the maturity of each capability.

## Envelope compatibility

Unknown extension fields are preserved on envelopes. Decision-evidence objects drop unknown fields, as described in [SECURITY.md](./SECURITY.md).

## Runtimes

- TypeScript package: Node.js 20 (as exercised in CI).
- Python package: see `python/pyproject.toml` for the supported Python versions.

Compatibility with other QuoxCORE major versions is not promised.

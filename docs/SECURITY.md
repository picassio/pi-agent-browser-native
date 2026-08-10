# Security policy

## Dependency audit policy

Release verification must include both the complete development graph and the shipped production graph:

```bash
npm audit
npm audit --omit=dev
```

The published package has no direct runtime dependencies. Pi APIs are peer dependencies supplied by the host, and development dependencies are not included in the package tarball. A non-zero production audit blocks release. A development-only finding requires an explicit, documented security review; there is no active exception.

## Resolved development advisories

The former Pi 0.80.9 development baseline installed vulnerable `brace-expansion` 5.0.6 and `protobufjs` 7.6.4 copies. The Pi 0.84.0 baseline resolves those denial-of-service advisories with `brace-expansion` 5.0.9 and `protobufjs` 7.6.5. A clean npm 11.14.0 install reports zero findings in both audit modes.

The Pi coding-agent package publishes an `npm-shrinkwrap.json`. Do not accept a root lockfile edit or override alone as remediation: verify the physical installed versions with `npm explain brace-expansion` and `npm explain protobufjs`. The safe minimums for these advisories are `brace-expansion` 5.0.8 and `protobufjs` 7.6.5.

Release evidence must also confirm that `npm pack` excludes `node_modules`. If either package reappears below its safe minimum, or this package begins processing untrusted glob patterns or `.proto` text, treat the finding as release-blocking until a fresh security review establishes otherwise.

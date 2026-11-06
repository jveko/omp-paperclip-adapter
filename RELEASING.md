# Releasing

Both packages ship from `.github/workflows/release.yml`, triggered by a `v*` tag.
Nothing is published from a workstation.

| Package | Version in | npm dist-tag |
|---|---|---|
| `omp-paperclip-adapter` | root `package.json` | `latest`, or `next` for a prerelease version |
| `paperclip-plugin-omp-session` | `paperclip-plugin-omp-session/package.json` | same rule |

The tag names the adapter version. The plugin is published only when its own version is
not already on the registry, so an adapter-only release does not republish the plugin.

## One-time setup

1. Make sure the npm account can publish both names (unscoped, public).
2. Create an npm **Automation** token (Publish, 2FA bypass) and add it as the
   `NPM_TOKEN` repository secret: Settings → Secrets and variables → Actions.
   The first publish of a brand-new package cannot use OIDC, so the token is
   required to bootstrap.
3. Optional: create the `npm` environment under Settings → Environments and add
   required reviewers. The publish job uses that environment, so the run waits
   for approval before touching the registry.

After the first publish you can drop the token:
npmjs.com → package → Settings → Trusted publishing → GitHub Actions, with repo
`jveko/omp-paperclip-adapter`, workflow `release.yml`, environment `npm`. Then delete the
`NPM_TOKEN` secret and the `Check npm credentials` step; the job authenticates with the
OIDC token instead, and `--provenance` keeps signing the tarballs.

## Cutting a release

1. Bump `version` in the root `package.json`. Bump the plugin's version only when the
   plugin changed.
2. Move the `Unreleased` section of `CHANGELOG.md` under
   `## <version> — <YYYY-MM-DD>`.
3. Commit with `chore(release): v<version>` and push to `master`.
4. Tag and push the tag:

   ```sh
   git tag v0.20.0
   git push origin v0.20.0
   ```

5. Watch the Release workflow. It:
   - rejects the tag unless it is `v<semver>` and equals the adapter version;
   - runs `npm run verify` (typecheck, unit, plugin, conformance, both builds);
   - publishes with `--provenance --access public`;
   - creates a GitHub release with generated notes.

A version that is already on npm is skipped, so re-running a failed workflow is safe.
Never move a tag after its version is published: the registry copy is immutable.

## Check a publish

```sh
npm view omp-paperclip-adapter@<version> dist.attestations --json
npm view paperclip-plugin-omp-session@<version> dist.attestations --json
```

Both must list a `https://slsa.dev/provenance/v1` predicate naming this repository and
`release.yml`. `npm pack` locally only reports the file list; `node
scripts/release/publish.mjs . --dry-run` runs the real packaging step without publishing.

## Failures

- `E401`/`E403` on publish: the token expired, lacks publish rights, or 2FA bypass is off.
- Version mismatch: bump `package.json` and move the tag; do not edit the workflow.
- Publishing the same version twice: impossible by design; bump the version instead.
- The npm registry copy cannot be unpublished after 72 hours; treat a bad release as
  fixed forward with a new patch version.

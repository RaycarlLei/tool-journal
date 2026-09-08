# Build and inspect a package candidate

The public workflow creates a package candidate after the six OS/Node checks
pass. It has read-only repository permissions and does not create a release,
change a tag, or publish to a registry. Pull-request candidates refer to the
tested merge commit; only a successful main run is a release source.

## Reproduce locally

Start from a clean checkout of the commit you want to inspect, using the Node
version recorded in the workflow and the checked-in lockfile:

```sh
npm ci --ignore-scripts
npm run check
npm run release:candidate
```

The command prints a new directory under `artifacts/package-candidate-*` with
three files:

- The compiled `.tgz` archive that passed the offline consumer check.
- `build-provenance.json`: source commit and tree, lockfile SHA-256, Node/npm and
  platform versions, package members, and the archive SHA-256.
- `SHA256SUMS`: hashes of the archive and provenance file, written last.

The consumer installs the archive without network access or lifecycle hooks,
completes an operation through the public API, reopens SQLite to replay it, and
compiles a TypeScript consumer. Candidate generation rejects uncommitted source
and checks that the commit and tree have not changed during verification. It
copies that tested archive; it does not repack after testing.

Use a new candidate directory for each attempt. A directory without SHA256SUMS
is incomplete. Generated directories are ignored by Git and are never source
inputs. Local generation runs the package check, not the other operating systems
or the LangGraph suite; see the corresponding CI run for those results.

## Download and check a CI candidate

Open a successful **Journal checks** run and download the
`package-candidate-<commit>` artifact. GitHub requires a signed-in account to
download workflow artifacts, and they expire after 30 days. Published releases
remain the distribution channel for users.

Extract the artifact into a new directory and locate the three files. On systems
with `sha256sum`, run this inside that directory:

```sh
sha256sum --check SHA256SUMS
```

On PowerShell, `Get-FileHash *.tgz, build-provenance.json -Algorithm SHA256`
prints the corresponding values for comparison with SHA256SUMS. Compare the
provenance commit with the workflow's tested commit, then inspect that commit's
source and checks. A green pull-request run is not proof that its merge result
is the released source; use the final main run.

## Promote deliberately

Before a release, update the package version and lockfile, changelog, supported
version policy and installation instructions in the normal reviewed change.
After merging, require successful checks for that exact main commit. Download
its candidate and verify the hashes and source identity before publishing the
same archive. Keep any experiment reports tied to that same source; their
metadata and workload results need separate inspection.

After publication, download the public assets again and compare their hashes.
Do not replace an existing version's tag or archive to correct a bad release;
publish a new version with the correction explained.

These files record build inputs and detect mismatched bytes. They are not a
cryptographic attestation, an independent security review, or a claim that every
host produces a byte-identical archive. Trust still includes the reviewed source,
the workflow, its dependencies and the distribution account. Never include
credentials, local database files or private logs in a candidate.

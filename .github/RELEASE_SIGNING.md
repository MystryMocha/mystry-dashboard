# Release GPG Signing Setup

**English** · [简体中文](RELEASE_SIGNING.zh-CN.md)

The `SHA256SUMS` of public Preview assets is signed with a GPG key held by the maintainer. The repository files and the GitHub Environment must agree, and before creating a Release the pipeline verifies the signature in a standalone keyring.

## First-Time Maintainer Setup

1. Generate or choose a GPG key used only for releases (RSA 4096 or Ed25519 recommended, with a passphrase).
2. Export the ASCII-armored **public key** to [`.github/release-signing-key.asc`](release-signing-key.asc) (committed to `main`).
3. Write the public key fingerprint (40 hex digits, no spaces, upper case recommended) on a line of its own in [`.github/release-signing-key.fingerprint`](release-signing-key.fingerprint).
4. In the GitHub repository under **Settings → Environments → `release`**, configure:
   - `RELEASE_GPG_PRIVATE_KEY`: the ASCII-armored private key (Secret, required)
   - `RELEASE_GPG_PASSPHRASE`: the private key passphrase (Secret, required when there is one)
   - `RELEASE_GPG_FINGERPRINT`: the same fingerprint as the `.fingerprint` file in the repository (Secret or Variable, required)
5. Enable **Required reviewers** (manual approval) for the `release` Environment, and restrict access to workflows triggered by tags on `main` (see [docs/portable-release.md](../docs/portable-release.md)).

To check the fingerprint locally:

```bash
gpg --import --import-options show-only .github/release-signing-key.asc
gpg --fingerprint --with-colons "$(head -n1 .github/release-signing-key.fingerprint)"
```

## Verifying Release Assets as a User

Download `mystry-release-signing-key.asc` (or the public key of the same name in the repository), `SHA256SUMS` and `SHA256SUMS.asc` from the GitHub Release.

```bash
gpg --import mystry-release-signing-key.asc
gpg --fingerprint
# Compare with release-signing-key.fingerprint or the fingerprint in the release notes (must match exactly)

sha256sum -c SHA256SUMS --ignore-missing
gpg --verify SHA256SUMS.asc SHA256SUMS
```

On Windows, use [Gpg4win](https://gpg4win.org/) or `gpg` inside WSL; the steps are the same.

## Pipeline Verification Order (Summary)

1. After importing the CI private key, assert that the secret key fingerprint equals `RELEASE_GPG_FINGERPRINT`.
2. Assert that `.github/release-signing-key.fingerprint` in the repository matches the Environment fingerprint.
3. Create a detached signature of `SHA256SUMS` with `--local-user <fingerprint>`.
4. Verify `SHA256SUMS.asc` in a temporary keyring that holds only the repository public key, and only then run `gh release create`.

The pinned SHAs of third-party Actions are in [actions-pins.md](actions-pins.md).

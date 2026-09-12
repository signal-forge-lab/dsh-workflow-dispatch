# DSH Workflow Dispatch

[English](README.md) | [日本語](README.ja.md)

DSH Workflow Dispatch is a policy and routing layer for DSH workflows. It centralizes model-role selection, capacity limits, usage admission, free-quota protection, and bounded failover without embedding credentials in source control.

## Repository layout

- `index.js` — dispatch entry point.
- `model-policy.json` — public model/provider routing policy. It contains model identifiers and limits, not API credentials.
- `model-policy.js` — policy loading and selection logic.
- `usage-admission.js` / `free-quota-guard.js` — admission and quota controls.
- `artifact-bridge.js` — bounded artifact transfer integration.
- `cordis.patch.yml` — generic public workflow registration patch.
- `dsh-sops.ps1` — optional launcher that reads credential *names* from a local DSH profile and injects matching values from a local SOPS store into the child process only.

## Configuration

The checked-in policy files are safe public defaults. Machine-specific state belongs outside the repository.

A local DSH profile may refer to credentials by environment-variable name, for example:

```yaml
apiKeyEnv: PROVIDER_API_KEY
```

The repository must never contain the corresponding value. If `dsh-sops.ps1` is used, the encrypted SOPS file remains the source of truth and secrets are injected into the process environment only for the launched DSH child.

The default local SOPS location used by the helper is derived from `$HOME`; it can be overridden with the script's `-SecretFile` parameter. Do not commit decrypted stores, `.env` files, private keys, provider tokens, generated runtime state, or workstation-specific profile files.

## Development

```powershell
npm install
npm test
```

Use local state directories for smoke runs and generated responses. They are excluded by `.gitignore`.

## Public-repository policy

- `main` and every public feature branch must be safe to disclose.
- Secrets and machine-specific settings are supplied externally.
- Public configuration files use generic identifiers and examples only.
- Generated state, logs, local profiles, and temporary responses are not source artifacts.

This repository is an in-development public snapshot; routing choices and provider availability may change over time.

## Branching strategy

This public repository uses branches only for development flow:

- `main` — stable, public-ready code.
- `develop` — integration branch for in-development changes that are still safe to publish.
- `feature/*` — short-lived public-safe feature branches created from `develop`.

Branches are **not** a security boundary. Secrets, personal data, machine-specific paths, and internal-only code must never be committed to any branch in this public repository. Keep those in ignored local files, an external secret store such as SOPS, or a separate private repository when internal-only source code is required.

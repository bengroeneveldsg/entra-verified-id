# Entra Verified ID — v2

Passwordless QR-code authentication using Microsoft Entra Verified ID. Users authenticate by scanning a QR code with Microsoft Authenticator to present a VerifiedEmployee credential — no password required.

## What's Included

- **Public login portal** — CloudFront + ECS Fargate serving a React/MUI SPA
- **SAML Identity Provider** — replaces Entra for SAML-federated apps (AppStream, WorkSpaces, etc.)
- **Credential issuance** — one-time flow to issue a VerifiedEmployee credential to a user's Authenticator
- **Admin console** — VPN-only internal UI for managing SAML apps, signing keys, audit logs, and system config
- **AWS CDK** — all infrastructure as code; single `./deploy.sh` deploys everything

## Quick Start

```bash
cd v2
./deploy.sh
```

The interactive script handles VPC/subnet selection, ACM cert creation, CDK bootstrap, and full stack deploy. After deploy it prints the admin console URL and one-time bootstrap credentials. Complete the onboarding wizard to configure your Entra tenant.

## Architecture

See [CLAUDE.md](./CLAUDE.md) for full technical documentation.

## Stacks

| Stack | Purpose |
|---|---|
| `EntraVid-Data-<stage>` | DynamoDB tables, Secrets Manager, S3 hosting bucket |
| `EntraVid-Layers-<stage>` | Lambda layer (cryptography, lxml, powertools) |
| `EntraVid-MainApp-<stage>` | Lambda functions + API Gateway |
| `EntraVid-PublicFrontend-<stage>` | Public Fargate + CloudFront |
| `EntraVid-Admin-<stage>` | Admin Fargate (VPN-only) |

## Adding a SAML Application

1. Upload the IdP metadata (admin console → SAML Apps → Download IdP Metadata) to AWS IAM as a SAML Provider
2. Create an IAM Role trusting that provider
3. Admin console → **SAML Applications → Add App**
4. The tile appears automatically on the landing page

## Key Technologies

- **Infra**: AWS CDK (TypeScript), ECS Fargate, Lambda, API Gateway, DynamoDB, CloudFront
- **Backend**: Python 3.12, FastAPI, AWS Lambda Powertools
- **Frontend**: React 18, MUI v5, Vite
- **Identity**: Microsoft Entra Verified ID REST API, SAML 2.0 (lxml + cryptography)

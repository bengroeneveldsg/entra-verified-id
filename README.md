# Entra Verified ID

A production-ready AWS deployment that enables **passwordless QR-code authentication** using Microsoft Entra Verified ID. Users authenticate by scanning a QR code with Microsoft Authenticator and presenting a VerifiedEmployee digital credential — no password, no OTP, no phishing risk.

---

## Contents

1. [What it does](#what-it-does)
2. [How Verified ID works](#how-verified-id-works)
3. [Architecture](#architecture)
4. [Prerequisites](#prerequisites)
5. [Deploying](#deploying)
6. [Configuration](#configuration)
7. [Authentication flows](#authentication-flows)
8. [SAML IdP](#saml-idp)
9. [Admin console](#admin-console)
10. [Signing keys](#signing-keys)
11. [Security model](#security-model)
12. [Development](#development)
13. [Troubleshooting](#troubleshooting)

---

## What it does

| Feature | Description |
|---|---|
| **Credential issuance** | A user visits `/issue`, scans a QR code, and receives a VerifiedEmployee credential in Microsoft Authenticator |
| **Standalone QR login** | Any application can use `/api/login/start` to challenge a user with a QR code and receive their verified claims |
| **SAML IdP** | Replaces Entra as the identity provider for SAML-federated apps (AWS AppStream, WorkSpaces, etc.) — users scan a QR instead of entering a password |
| **Admin console** | A VPN-only internal web UI for managing SAML apps, signing keys, sessions, audit logs, and system configuration |

---

## How Verified ID works

Microsoft Entra Verified ID is a cloud service that issues and verifies cryptographically signed digital credentials. It uses W3C Verifiable Credentials and Decentralised Identifiers (DIDs) but exposes everything through simple REST APIs.

### Core concepts

**Credential** — a signed JSON document stored in Microsoft Authenticator containing claims about the user (name, job title, department, email). Issued by your Entra tenant and cryptographically linked to the tenant's DID.

**DID (Decentralised Identifier)** — a globally unique identifier for your organisation's identity authority, e.g. `did:web:verifiedid.entra.microsoft.com:tenant-id:did-id`. Used to verify that credentials came from a trusted source.

**Presentation request** — your application asks the user to *prove* they hold a valid credential. The user scans a QR and presents the credential from their wallet. Your app receives the verified claims.

**Issuance request** — your application asks Entra to *issue* a new credential to a user. The user scans a QR and the credential is written to their Authenticator wallet.

### Microsoft-published constants (same in every Entra tenant)

```
Verified ID service app ID:  3db474b9-6a0c-4840-96ac-1fceb342124f
OAuth scope:                 3db474b9-6a0c-4840-96ac-1fceb342124f/.default
Presentation API:            https://verifiedid.did.msidentity.com/v1.0/verifiableCredentials/createPresentationRequest
Issuance API:                https://verifiedid.did.msidentity.com/v1.0/verifiableCredentials/createIssuanceRequest
```

### Key request validation fields

| Field | Purpose |
|---|---|
| `authority` | Your organisation's DID |
| `acceptedIssuers` | List of trusted issuer DIDs — credentials from other issuers are rejected |
| `validateLinkedDomain: true` | Entra validates the DID against your domain's `.well-known/did-configuration.json` |
| `allowRevoked: false` | Reject credentials that have been revoked by the issuer |

### VerifiedEmployee claims

The standard Entra `VerifiedEmployee` credential includes: `displayName`, `givenName`, `surname`, `mail`, `userPrincipalName`, `jobTitle`, `department`, `employeeId`.

---

## Architecture

### Infrastructure overview

```
Internet users
      │
  CloudFront ──── *.yourdomain ACM cert (us-east-1)
      │
  Public ALB (internet-facing, public VPC subnets)
      │
  ECS Fargate ── Nginx ──────── proxy /api/* ──────▶ API Gateway
  (public SPA)                                           │
                                               6 Lambda functions
                                                        │
                                          DynamoDB + Secrets Manager + S3

VPN users (10.0.0.0/8)
      │
  Internal ALB ── WAF (VPN CIDR allowlist)
      │
  ECS Fargate ── FastAPI ── React admin SPA
  (admin console, private VPC)
```

### CDK stacks

All infrastructure is defined as AWS CDK TypeScript. Five stacks deploy in order:

| Stack | Key Resources |
|---|---|
| `EntraVid-Data-{stage}` | 5 DynamoDB tables, 3 Secrets Manager secrets, S3 hosting bucket |
| `EntraVid-Layers-{stage}` | Lambda layer: cryptography + lxml + aws-lambda-powertools |
| `EntraVid-MainApp-{stage}` | 6 Lambda functions + API Gateway HTTP API |
| `EntraVid-PublicFrontend-{stage}` | ECS Fargate service, internet-facing ALB, CloudFront distribution |
| `EntraVid-Admin-{stage}` | ECS Fargate service, internal ALB, WAF |

**No networking resources are created by CDK.** All VPCs, subnets, NAT gateways, and VPC endpoints must be pre-existing. Operators provide VPC and subnet IDs as deploy-time context.

### Lambda functions

| Function | Route(s) | Purpose |
|---|---|---|
| `login_start` | `POST /api/login/start` | Creates a VID presentation request; returns QR code + requestId |
| `login_callback` | `POST /api/login/callback` | Entra VID webhook — stores verified claims in DynamoDB |
| `login_status` | `GET /api/login/status/{requestId}` | Frontend polls this for verification result |
| `issue_start` | `POST /api/issue/start` | Creates a VID issuance request; returns QR code + requestId |
| `issue_callback` | `POST /api/issue/callback` | Entra VID webhook — records issuance success/failure |
| `saml_idp` | `GET\|POST /api/saml/*` | SAML 2.0 IdP: metadata, SSO, initiate, complete, app list |

---

## Prerequisites

- **AWS CLI v2** with SSO configured
- **Node.js 20+** and npm
- **Docker** (for building container images and Lambda layers)
- **`jq`**
- **Existing VPC(s)** — one public VPC with ≥2 public subnets and one private VPC with ≥2 private subnets. Both must be in the deployment region with appropriate routing already configured.
- **ACM certificate** — wildcard cert for your domain in `us-east-1` (for CloudFront). A regional cert for ALB HTTPS is optional.
- **Entra tenant** with Verified ID enabled (see Entra setup below)

### Entra setup

Create two app registrations in your Entra tenant:

**IssuerVerifier app** — used to call the Verified ID REST API:
- API permissions: `VerifiableCredential.Create.All` (Application, admin-consented)
- Create a client secret; note the Application (client) ID

Enable Verified ID in your tenant:
1. Azure Portal → Entra ID → Verified ID → Get started
2. Note your **DID authority** (e.g. `did:web:verifiedid.entra.microsoft.com:tenant-id:did-id`)
3. Note your **VerifiedEmployee manifest URL** from the credential contract

---

## Deploying

### First-time deployment

```bash
cd v2
./deploy.sh
```

The interactive script guides you through:
1. AWS profile and region selection
2. VPC and subnet selection (queries your account; presents a numbered list)
3. VPN CIDR configuration
4. Domain name entry
5. ACM certificate selection or creation (with automatic DNS validation via Route 53)
6. CDK bootstrap (if needed)
7. All 5 stacks deployed in dependency order
8. Post-deploy: admin URL, CloudFront URL, and one-time bootstrap credentials printed

All parameters are saved to `.deploy.env` (gitignored) — re-runs use saved values as defaults.

### After the first deploy

Access the admin console from your VPN and complete the **onboarding wizard**. The wizard collects your Entra tenant credentials, DID, domain settings, and generates signing keys. The system is not functional until the wizard is completed.

### Re-deploying after changes

```bash
export AWS_PROFILE=<profile>
export CDK_DEFAULT_ACCOUNT=<account-id>
export CDK_DEFAULT_REGION=<region>

# Lambda or CDK-only changes (fast, no Docker rebuild)
npx cdk deploy "EntraVid-MainApp-v2" --require-approval never

# Admin console changes
docker build -f admin/Dockerfile -t entra-vid-admin . && \
npx cdk deploy "EntraVid-Admin-v2" --require-approval never

# Public frontend changes
docker build -f frontend/Dockerfile -t entra-vid-frontend . && \
npx cdk deploy "EntraVid-PublicFrontend-v2" --require-approval never

# All stacks
npx cdk deploy --all --require-approval never
```

---

## Configuration

### Architecture

Configuration is split across two AWS services — **never hardcoded in code**:

| Store | Contents |
|---|---|
| `EntraVerifiedIDSystemConfig-{stage}` DynamoDB | Non-secret: tenant ID, domain names, DID, URLs, SAML endpoints, signing key ID |
| `EntraVerifiedID/{stage}/app` Secrets Manager | Secrets: `clientId`, `clientSecret`, `callbackSecret`, `eamSigningKey`, `eamKid` |

Lambda functions load both at cold start and cache for 5 minutes. The admin console writes via the setup wizard and the System Configuration page.

### Configuration keys reference

All written automatically by the onboarding wizard:

| Key | Store | Description |
|---|---|---|
| `tenant_id` | Config | Entra tenant directory ID |
| `issuer_verifier_client_id` | Config | App registration client ID for credential operations |
| `authority` / `did_authority` | Config | Your organisation's DID |
| `manifest_url` | Config | VerifiedEmployee credential contract manifest URL |
| `accepted_issuer` | Config | Trusted issuer DID for presentation validation |
| `public_domain` | Config | User-facing domain |
| `api_domain` | Config | API Gateway domain for webhook callbacks |
| `frontend_base_url` | Config | Full frontend URL including protocol |
| `callback_base_url` | Config | Base URL for Entra VID webhook callbacks |
| `client_name` | Config | Organisation name shown in QR screens |
| `entity_id` | Config | SAML IdP entity ID |
| `saml_sso_url` | Config | SAML SSO endpoint URL |
| `kid` | Config | Active signing key ID |
| `clientId` | Secret | IssuerVerifier app client ID |
| `clientSecret` | Secret | IssuerVerifier app client secret |
| `callbackSecret` | Secret | Webhook API key — auto-generated, 32 bytes |
| `eamSigningKey` | Secret | RSA-2048 private key PEM |
| `eamKid` | Secret | Signing key ID |

---

## Authentication flows

### Presentation flow (login / SAML)

```
1.  POST /api/login/start
    Lambda acquires OAuth token (client_credentials, scope 3db474b9.../.default)
    Lambda calls Entra VID createPresentationRequest
    Entra returns: requestId, QR code (base64 PNG), deep-link URL
    Lambda stores pending session in DynamoDB (TTL 10 min)
    Returns QR + requestId to frontend

2.  Frontend displays QR; polls GET /api/login/status/{requestId} every 2 seconds

3.  User scans QR with Microsoft Authenticator
    Authenticator contacts Entra VID service directly
    User selects and presents their VerifiedEmployee credential

4.  Entra VID calls POST /api/login/callback (webhook)
    Lambda validates x-api-key (constant-time comparison)
    Lambda validates requestId against DynamoDB
    presentation_verified: stores claims, pending → success
    presentation_error:    pending → failed

5.  Frontend poll gets status=success
    Lambda atomically transitions success → claimed (prevents double-issue)
    Returns verified claims: displayName, mail, jobTitle, etc.
```

### Issuance flow

```
1.  POST /api/issue/start
    Lambda calls Entra VID createIssuanceRequest
    Returns QR + requestId

2.  User scans QR with Authenticator
    Authenticator authenticates against Entra
    Credential written to Authenticator wallet

3.  Entra VID calls POST /api/issue/callback twice:
    request_retrieved:    user scanned — show "scanning…" UI
    issuance_successful:  credential issued — show success screen
```

### Session status transitions

```
pending → request_retrieved → success → claimed   (happy path)
pending → failed                                   (verification failed)
```

---

## SAML IdP

### Flow

```
SP sends AuthnRequest (HTTP-Redirect or HTTP-POST binding)
    │
    ▼  GET /api/saml/sso
Lambda parses AuthnRequest, creates SAML session in DynamoDB
    │
    ▼  Redirect to {frontend}/saml?session={id}
Frontend shows QR code (calls /api/login/start internally)
    │
    ▼  User scans, credential verified via standard presentation flow
Frontend calls GET /api/saml/complete?session={id}&vid={requestId}
    │
    ▼  Lambda builds signed SAML assertion (lxml + RSA-PKCS1v15 + exclusive C14N)
Browser auto-POSTs SAMLResponse to SP ACS URL
    │
    ▼  SP grants access
```

For landing-page initiated flows (no SP redirect), `/api/saml/initiate?app={appId}` creates the session directly.

### Adding a SAML application

**Step 1** — Upload IdP metadata to AWS IAM (one-time, shared across all apps):
1. Admin console → SAML Applications → **Download IdP Metadata**
2. AWS IAM Console → Identity providers → Add provider → SAML → upload the XML
3. Note the provider ARN: `arn:aws:iam::{account}:saml-provider/{name}`

**Step 2** — Create an IAM role:

```json
{
  "Effect": "Allow",
  "Principal": { "Federated": "arn:aws:iam::{account}:saml-provider/{name}" },
  "Action": "sts:AssumeRoleWithSAML",
  "Condition": {
    "StringEquals": { "SAML:aud": "https://signin.aws.amazon.com/saml" }
  }
}
```

**Step 3** — Admin console → SAML Applications → Add App.

The app tile appears on the public landing page immediately after saving.

> **Key rotation**: After rotating signing keys, re-upload the IdP metadata to your IAM SAML provider. The old certificate will no longer be trusted.

---

## Admin Console

Accessible from VPN only. URL is printed by `deploy.sh`.

### Pages

| Page | Purpose |
|---|---|
| **Dashboard** | System status, SAML app count, active sessions, signing key age, recent audit events |
| **SAML Applications** | Add/edit/disable apps; download IdP metadata; copy metadata URL |
| **Sessions** | Active in-flight VID sessions (users currently mid-authentication); revoke stuck sessions |
| **Signing Keys** | Current key ID, JWKS URL, rotation (grace window keeps old key active) |
| **System Config** | All configuration values grouped by category; inline editing for non-secret, non-read-only keys |
| **Audit Log** | Admin action audit trail + container runtime logs (health checks and lifecycle events filtered) |

### Onboarding wizard

Run once on first access. Six steps collect all required configuration. Progress is saved between steps — close the browser and resume later. The wizard is permanently locked after completion; use System Config for post-setup changes.

---

## Signing Keys

### What is signed

- **SAML assertions** — every SAML response is signed with the RSA private key
- The public key is exposed in the JWKS at `/.well-known/jwks.json` and in IdP metadata

### Storage

| Item | Location |
|---|---|
| Private key PEM | Secrets Manager → `eamSigningKey` |
| Public JWKS | S3 hosting bucket → `.well-known/jwks.json` |
| OIDC discovery | S3 hosting bucket → `.well-known/openid-configuration` |
| Key ID (kid) | SystemConfig DynamoDB → `kid` |

### Rotation

Admin console → Signing Keys → **Rotate Keys**.

A new RSA-2048 keypair is generated. The JWKS is updated with **both old and new keys** during a grace window — existing in-flight SAML sessions remain valid. After rotation, download fresh IdP metadata and update your IAM SAML provider.

---

## Security model

### Webhook authentication

All Entra VID callbacks authenticate via the `x-api-key` header. The `callbackSecret` is validated with **constant-time comparison** to prevent timing attacks. Generated automatically during setup (32 bytes, URL-safe base64).

### Admin authentication

- **Argon2id** password hashing
- **TOTP MFA** enforced after first login
- **JWT cookies** — `HttpOnly`, `SameSite=Lax`; `Secure` flag enabled when HTTPS is configured
- **Brute force** — 5 failed attempts → 15-minute account lock
- **Network** — internal ALB + WAF IP allowlist (VPN CIDR); no public path exists

### Lambda IAM (least privilege)

Lambdas share one IAM role with:
- DynamoDB: `GetItem`, `PutItem`, `UpdateItem`, `Query` on specific table ARNs only
- Secrets Manager: `GetSecretValue` on the app secret ARN only
- S3: `GetObject` on the hosting bucket (for SAML signing certificate)

### SAML XML signing

- Algorithm: RSA-PKCS1v15 + SHA-256
- Canonicalisation: exclusive C14N via `lxml` (`transform_uri = "http://www.w3.org/2001/10/xml-exc-c14n#"`)
- ACS URL: always read from DynamoDB config — never taken from the `AuthnRequest`

---

## Development

### Local setup

```bash
npm install                    # CDK + workspace dependencies

# Admin backend (Python)
cd admin && pip install -e ".[dev]"
uvicorn app.main:app --reload --port 8000

# Admin SPA
cd admin/web && npm run dev    # http://localhost:3001

# Public frontend
cd frontend && npm run dev     # http://localhost:5173
```

### TypeScript checks

```bash
npx tsc --noEmit
```

### CDK synth (validate without deploying)

```bash
AWS_PROFILE=<profile> CDK_DEFAULT_ACCOUNT=<account> CDK_DEFAULT_REGION=<region> \
  npx cdk synth --quiet
```

### Lambda shared helpers

- `lambdas/shared/config.py` — reads SystemConfig from DynamoDB with 5-minute in-memory cache
- `lambdas/shared/secrets.py` — reads Secrets Manager with 5-minute cache; tries the Parameters & Secrets Lambda Extension first (faster), falls back to direct boto3

---

## Troubleshooting

### "Could not start sign-in" on SAML flow
- Check the `/api/saml/initiate` route is registered in API Gateway (should be in `main-app-stack.ts`)
- Verify the Lambda role has `s3:GetObject` on the hosting bucket — needed to read the signing certificate

### SAML signature fails at the SP
- The signing certificate changed after a key rotation. Re-download IdP metadata from the admin console and re-upload to your IAM SAML provider.

### Admin console login signs out immediately
- `SECURE_COOKIE=true` but the admin ALB is HTTP-only. Set `SECURE_COOKIE=false` in the container environment (CDK: set `hasCustomDomain = false`).

### "System configuration not initialised" from Lambdas
- The onboarding wizard was not completed. Access the admin console and finish all wizard steps.
- Verify `onboarding_complete = true` exists in `EntraVerifiedIDSystemConfig-{stage}` DynamoDB.

### SAML metadata download fails (503)
- The S3 hosting bucket JWKS has not been uploaded yet (wizard keys step not completed).
- Check the Lambda has `s3:GetObject` permission on `.well-known/jwks.json`.

### API calls return 403 from CloudFront
- Nginx is forwarding `Host: {your-domain}` to API Gateway (which doesn't know that hostname). Nginx config must use `proxy_set_header Host $proxy_host;` not `$http_host`.

### Admin audit log shows 500
- The admin task role needs `dynamodb:Query` permission. Check `tables.auditLog.grantReadWriteData(taskRole)` in `admin-stack.ts`.

---

## Project structure

```
v2/
├── bin/app.ts                   CDK entry point — context-driven, no hardcoded values
├── lib/
│   ├── data-stack.ts            DynamoDB tables, Secrets Manager, S3
│   ├── layers-stack.ts          Lambda dependency layer (Docker build)
│   ├── main-app-stack.ts        Lambda functions + API Gateway routes
│   ├── public-frontend-stack.ts ECS Fargate + internet ALB + CloudFront
│   └── admin-stack.ts           Admin ECS Fargate + internal ALB + WAF
├── lambdas/
│   ├── shared/                  config.py, secrets.py (TTL-cached helpers)
│   ├── login_start/             Presentation request creation
│   ├── login_callback/          Presentation webhook receiver
│   ├── login_status/            Status polling endpoint
│   ├── issue_start/             Issuance request creation
│   ├── issue_callback/          Issuance webhook receiver
│   └── saml_idp/                SAML 2.0 IdP (metadata, SSO, initiate, complete)
├── frontend/
│   ├── src/pages/               Landing, Login, Issue, Saml
│   └── nginx.conf               API proxy + health endpoint
├── admin/
│   ├── app/routes/              auth, setup, saml_apps, sessions, keys, config, audit
│   ├── app/services/            key_service, setup_service
│   └── web/src/pages/           Dashboard, SamlApps, Sessions, Keys, Config, Audit
├── layer/Dockerfile             Lambda layer (cryptography, lxml, powertools)
├── shared-ui/src/               Shared MUI theme, FlowCard, QrDisplay, StatusBadge
└── deploy.sh                    Interactive multi-tenant deployment script
```

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
| **Standalone QR login** | Any application can call `/api/login/start` to challenge a user with a QR code and receive their verified claims |
| **SAML IdP** | Replaces Entra as the identity provider for SAML-federated apps (AppStream, WorkSpaces, etc.) — users scan a QR instead of entering a password |
| **Admin console** | A VPN-only internal web UI for managing SAML apps, signing keys, sessions, audit logs, and system configuration |

---

## How Verified ID works

Microsoft Entra Verified ID is a cloud service that issues and verifies cryptographically signed digital credentials. It abstracts W3C Verifiable Credentials and Decentralised Identifiers (DIDs) behind simple REST APIs.

### Core concepts

**Credential** — a signed JSON document stored in Microsoft Authenticator containing claims about the user (name, job title, department, email). Issued by your Entra tenant and cryptographically linked to the tenant's DID.

**DID (Decentralised Identifier)** — a globally unique identifier for your organisation's identity authority, e.g. `did:web:verifiedid.entra.microsoft.com:tenant-id:did-id`. Used to verify that credentials were issued by a trusted source.

**Presentation request** — your application asks the user to *prove* they hold a valid credential. The user scans a QR and presents the credential from their wallet. Your app receives the verified claims.

**Issuance request** — your application asks Entra to *issue* a new credential to a user. The user scans a QR and the credential is written to their Authenticator wallet.

### Microsoft-published constants (same in every tenant globally)

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
| `validateLinkedDomain: true` | Entra validates the DID is linked to your domain via `.well-known/did-configuration.json` |
| `allowRevoked: false` | Reject credentials that have been revoked by the issuer |

### VerifiedEmployee claims

The standard Entra `VerifiedEmployee` credential includes: `displayName`, `givenName`, `surname`, `mail`, `userPrincipalName`, `jobTitle`, `department`, `employeeId`.

---

## Architecture

### Infrastructure overview

```mermaid
flowchart TD
    subgraph Internet["Internet"]
        U([Internet Users])
        CVPN([Client VPN])
    end

    subgraph CorpNet["Corporate Network"]
        CORP([Corporate Office\n/ Branch])
        DX[Direct Connect /\nSite-to-Site VPN]
    end

    subgraph PublicEdge["Public Edge"]
        CF[CloudFront\nACM cert us-east-1]
    end

    subgraph Private["Private Subnets (NAT/Cloud WAN egress)"]
        FALB[Internal ALB\nVPC Origin]
        FG[ECS Fargate\nNginx + React SPA]
        WAF[WAF\nIP Allowlist]
        AALB[Internal ALB]
        ADM[ECS Fargate\nFastAPI + React]
    end

    subgraph API["API Layer (no VPC)"]
        APIGW[API Gateway\nHTTP API]
        L1[login_start\nlogin_callback\nlogin_status]
        L2[issue_start\nissue_callback]
        L3[saml_idp]
    end

    subgraph Data["Data Layer"]
        DDB[(DynamoDB\n5 tables)]
        SM[(Secrets Manager)]
        S3[(S3\nhosting bucket)]
    end

    U --> CF -- "VPC Origin" --> FALB --> FG
    FG -- "proxy /api/*" --> APIGW
    APIGW --> L1 & L2 & L3
    L1 & L2 & L3 --> DDB & SM
    L3 --> S3

    CVPN -- "private IP range" --> WAF
    CORP --> DX -- "private IP range" --> WAF
    WAF --> AALB --> ADM
    ADM --> DDB & SM & S3
```

### CDK stacks

All infrastructure is defined as AWS CDK TypeScript. Five stacks deploy in dependency order:

| Stack | Key Resources |
|---|---|
| `EntraVid-Data-{stage}` | 5 DynamoDB tables, 3 Secrets Manager secrets, S3 hosting bucket |
| `EntraVid-Layers-{stage}` | Lambda layer: cryptography + lxml + aws-lambda-powertools |
| `EntraVid-MainApp-{stage}` | 6 Lambda functions + API Gateway HTTP API |
| `EntraVid-PublicFrontend-{stage}` | ECS Fargate + internal ALB in private subnets, CloudFront distribution with VPC Origin |
| `EntraVid-Admin-{stage}` | ECS Fargate (private subnets), internal ALB, WAF |

> **No networking resources are created by CDK.** All VPCs, subnets, NAT gateways, and routing must be pre-existing. Operators supply VPC and subnet IDs as deploy-time context parameters.

### Lambda functions

| Function | Route(s) | Purpose |
|---|---|---|
| `login_start` | `POST /api/login/start` | Creates a VID presentation request; returns QR code + requestId |
| `login_callback` | `POST /api/login/callback` | Entra VID webhook — stores verified claims in DynamoDB |
| `login_status` | `GET /api/login/status/{requestId}` | Frontend polls this for the verification result |
| `issue_start` | `POST /api/issue/start` | Creates a VID issuance request; returns QR code + requestId |
| `issue_callback` | `POST /api/issue/callback` | Entra VID webhook — records issuance success or failure |
| `saml_idp` | `GET\|POST /api/saml/*` | SAML 2.0 IdP: metadata, SSO, initiate, complete, app list |

---

## Prerequisites

### Required tools

| Tool | Purpose | Notes |
|---|---|---|
| AWS CLI v2 | All AWS operations | Must be configured with credentials (see [Deploying](#deploying)) |
| Node.js 20+ | CDK execution | Install via [nodejs.org](https://nodejs.org) |
| npm 9+ | Package management | Bundled with Node.js |
| Docker | Build container images and Lambda layers | Required for full deployments. Not required for Lambda-only CDK updates. |
| `jq` | Used by `deploy.sh` | `apt install jq` / `brew install jq` |

### Required AWS resources (pre-existing)

| Resource | Requirement |
|---|---|
| VPC with internet gateway (frontend) | CloudFront VPC Origin requires the target VPC to have an IGW attached. The frontend internal ALB and Fargate tasks live here. If the VPC only has public subnets, Fargate tasks need a public IP for ECR pulls; adding private subnets with NAT removes that requirement. |
| Private subnets with egress (admin) | ≥ 2 subnets in different AZs with outbound internet access (NAT gateway or Cloud WAN) — used for the admin internal ALB and Fargate tasks. |
| ACM certificate | Wildcard cert for your domain in `us-east-1` (for CloudFront). No regional cert needed — both ALBs are HTTP-only internally; TLS terminates at CloudFront. |

### Required Entra configuration

Complete the following steps in the **Azure Portal** before running `deploy.sh`. The values collected here are entered into the onboarding wizard after deployment.

---

#### Step 1 — Enable Verified ID

1. Sign in to [portal.azure.com](https://portal.azure.com) as a Global Administrator
2. Navigate to **Entra ID → Verified ID → Get started**
3. Follow the quick setup wizard — select **Microsoft-managed** for the DID (recommended)
4. After setup completes, go to **Verified ID → Overview** and note:
   - **Authority (DID)** — e.g. `did:web:verifiedid.entra.microsoft.com:260c418f...:3bc8e7d0...`
   - This is your DID authority — required in the wizard

---

#### Step 2 — Create the VerifiedEmployee credential type

If your tenant does not already have a VerifiedEmployee credential contract:

1. **Verified ID → Credentials → Add credential**
2. Select **VerifiedEmployee** from the template gallery
3. Configure display settings and claims mapping to your directory attributes
4. After creation, go to the credential and note the **Manifest URL** — e.g.:
   `https://verifiedid.did.msidentity.com/v1.0/tenants/{tenantId}/verifiableCredentials/contracts/{contractId}/manifest`

---

#### Step 3 — Create the IssuerVerifier app registration

This app registration is used by the Lambda functions to call the Verified ID REST API.

1. **Entra ID → App registrations → New registration**
   - Name: `VerifiedID-IssuerVerifier` (or your preferred name)
   - Supported account types: Accounts in this organisational directory only
   - No redirect URI required
2. After creation, note the **Application (client) ID** — this is your `clientId`
3. **Certificates & secrets → Client secrets → New client secret**
   - Set an expiry (12 or 24 months)
   - Copy the **Value** immediately — it is only shown once. This is your `clientSecret`
4. **API permissions → Add a permission → APIs my organisation uses**
   - Search for `Verifiable Credential`
   - Select **Verifiable Credentials Service Request**
   - Add application permission: `VerifiableCredential.Create.All`
5. **Grant admin consent** — click **Grant admin consent for {organisation}** and confirm

> The `VerifiableCredential.Create.All` permission with admin consent is required for the Lambda functions to create presentation and issuance requests on behalf of your tenant.

---

#### Step 4 — Note your tenant ID

1. **Entra ID → Overview**
2. Copy the **Directory (tenant) ID** — a UUID in the format `xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx`

---

#### Entra configuration summary

Collect these values before running the onboarding wizard:

| Value | Where to find it |
|---|---|
| Tenant ID | Entra ID → Overview → Directory (tenant) ID |
| IssuerVerifier Client ID | App registration → Overview → Application (client) ID |
| IssuerVerifier Client Secret | App registration → Certificates & secrets |
| DID Authority | Verified ID → Overview → Authority |
| Manifest URL | Verified ID → Credentials → your credential → Manifest URL |
| Accepted Issuer DID | Same as DID Authority (for same-tenant issuance) |

---

## Deploying

### Required IAM permissions

The AWS identity deploying the stacks needs the following permissions. The easiest approach is `AdministratorAccess` for the initial deploy, then scope down for updates.

For a scoped deploy policy, the minimum required service actions are:

```
cloudformation:*
ecr:*
ecs:*
lambda:*
iam:CreateRole, iam:AttachRolePolicy, iam:PutRolePolicy, iam:PassRole,
    iam:GetRole, iam:DeleteRole, iam:DetachRolePolicy
ec2:DescribeVpcs, ec2:DescribeSubnets, ec2:CreateSecurityGroup,
    ec2:AuthorizeSecurityGroupIngress, ec2:DescribeSecurityGroups
elasticloadbalancing:*
cloudfront:*
dynamodb:CreateTable, dynamodb:DescribeTable, dynamodb:DeleteTable,
    dynamodb:UpdateTable, dynamodb:TagResource
secretsmanager:CreateSecret, secretsmanager:GetSecretValue,
    secretsmanager:PutSecretValue, secretsmanager:UpdateSecret
s3:CreateBucket, s3:PutBucketPolicy, s3:PutObject, s3:GetObject
acm:RequestCertificate, acm:DescribeCertificate, acm:ListCertificates
route53:ChangeResourceRecordSets, route53:ListHostedZones
wafv2:CreateWebACL, wafv2:CreateIPSet, wafv2:AssociateWebACL
logs:CreateLogGroup, logs:PutRetentionPolicy
ssm:GetParameter (CDK bootstrap)
```

---

### Option 1 — Local machine with AWS SSO

Use this if your organisation uses AWS SSO (IAM Identity Center).

```bash
# Log in
aws sso login --profile <your-profile>

# Verify
aws sts get-caller-identity --profile <your-profile>

# Deploy
cd v2
./deploy.sh
# Select your SSO profile when prompted
```

---

### Option 2 — Local machine with IAM user credentials

Use this if you have a long-lived IAM user with access keys.

```bash
# Configure credentials
aws configure --profile deploy-user
# Enter: Access Key ID, Secret Access Key, region, output format

# Verify
aws sts get-caller-identity --profile deploy-user

# Set environment and deploy
export AWS_PROFILE=deploy-user
cd v2
./deploy.sh
```

Or use environment variables directly (useful in scripts):

```bash
export AWS_ACCESS_KEY_ID=AKIA...
export AWS_SECRET_ACCESS_KEY=...
export AWS_DEFAULT_REGION=ap-southeast-1

cd v2
./deploy.sh
```

---

### Option 3 — Local machine with IAM role assumption

Use this if you need to assume a deployment role (common in multi-account setups).

```bash
# Add to ~/.aws/config
[profile deploy-role]
role_arn = arn:aws:iam::123456789012:role/DeploymentRole
source_profile = default   # or another profile with sts:AssumeRole permission
region = ap-southeast-1

# Verify role assumption
aws sts get-caller-identity --profile deploy-role

# Deploy
export AWS_PROFILE=deploy-role
cd v2
./deploy.sh
```

---

### Option 4 — AWS CloudShell

> **Note:** CloudShell includes Docker. Full deployments that build container images (first deploy, admin console changes, frontend changes) work in CloudShell, but each session starts fresh with no Docker layer cache — builds will be slower than on a persistent machine.

CloudShell already has AWS CLI and Node.js. You only need to install CDK:

```bash
# In CloudShell — install Node.js 20 and CDK
curl -fsSL https://rpm.nodesource.com/setup_20.x | sudo bash -
sudo yum install -y nodejs
npm install -g aws-cdk

# Clone the repo
git clone https://github.com/your-org/entra-verified-id.git
cd entra-verified-id/v2
npm install

# For Lambda-only or config-only changes (no Docker required)
export CDK_DEFAULT_ACCOUNT=$(aws sts get-caller-identity --query Account --output text)
export CDK_DEFAULT_REGION=$AWS_DEFAULT_REGION

npx cdk deploy "EntraVid-MainApp-v2" --require-approval never
```

CloudShell credentials are automatically available — no configuration needed.

---

### Option 5 — EC2 instance (recommended for CI/CD or team pipelines)

An EC2 instance with an IAM instance profile is the cleanest approach for automated deployments.

```bash
# On an EC2 instance with appropriate instance profile
# Install prerequisites
sudo yum update -y
curl -fsSL https://rpm.nodesource.com/setup_20.x | sudo bash -
sudo yum install -y nodejs docker git jq
sudo systemctl start docker
sudo usermod -aG docker ec2-user
sudo npm install -g aws-cdk
newgrp docker

# Clone and deploy
git clone https://github.com/your-org/entra-verified-id.git
cd entra-verified-id/v2
npm install

export CDK_DEFAULT_ACCOUNT=$(aws sts get-caller-identity --query Account --output text)
export CDK_DEFAULT_REGION=ap-southeast-1

./deploy.sh --non-interactive   # uses .deploy.env for all parameters
```

---

### First-time deployment (any option)

Once authenticated, run:

```bash
cd v2
./deploy.sh
```

The script guides you through:

1. **Credential verification** — confirms your AWS identity before proceeding
2. **VPC selection** — queries your account and presents a numbered list of VPCs and subnets
3. **VPN CIDR** — the IP range allowed to reach the admin console
4. **Domain** — your public-facing domain (e.g. `vid.yourdomain.com`)
5. **ACM certificates** — select existing or create new DNS-validated certificates
6. **CDK bootstrap** — runs automatically if not already bootstrapped in the account/region
7. **Stack deployment** — all 5 stacks deployed in dependency order with progress output
8. **Post-deploy summary** — prints public URL, admin URL, and one-time bootstrap credentials

All parameters are saved to `.deploy.env` (gitignored) — subsequent runs use saved values as defaults.

### After the first deploy

Access the admin console from your VPN and complete the **onboarding wizard** (see [Admin Console](#admin-console)). The system is not functional until the wizard is completed — it collects your Entra tenant credentials, DID, domain settings, and generates signing keys.

### Re-deploying after changes

```bash
# Set account and region
export CDK_DEFAULT_ACCOUNT=<account-id>
export CDK_DEFAULT_REGION=ap-southeast-1
# Plus your credential method (profile / env vars / instance role)

# Lambda code changes only (fast, no Docker build needed)
npx cdk deploy "EntraVid-MainApp-v2" --require-approval never

# Admin console changes (requires Docker)
docker build -f admin/Dockerfile -t entra-vid-admin .
npx cdk deploy "EntraVid-Admin-v2" --require-approval never

# Public frontend changes (requires Docker)
docker build -f frontend/Dockerfile -t entra-vid-frontend .
npx cdk deploy "EntraVid-PublicFrontend-v2" --require-approval never

# All stacks
npx cdk deploy --all --require-approval never
```

---

## Configuration

### Architecture

Configuration is split across two AWS services — **never hardcoded**:

| Store | Contents |
|---|---|
| `EntraVerifiedIDSystemConfig-{stage}` DynamoDB | Non-secret: tenant ID, domain names, DID, URLs, SAML endpoints, signing key ID |
| `EntraVerifiedID/{stage}/app` Secrets Manager | Secrets: `clientId`, `clientSecret`, `callbackSecret`, `eamSigningKey`, `eamKid` |

Lambda functions load both at cold start and cache for 5 minutes. The admin console writes via the setup wizard and the System Configuration page.

### Configuration keys reference

All keys are written automatically by the onboarding wizard:

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
| `callbackSecret` | Secret | Webhook API key — auto-generated 32-byte random value |
| `eamSigningKey` | Secret | RSA-2048 private key PEM |
| `eamKid` | Secret | Signing key ID |

---

## Authentication flows

### Presentation flow (QR login / SAML authentication)

```mermaid
sequenceDiagram
    participant B as Browser
    participant L as Lambda
    participant E as Entra VID
    participant A as Authenticator

    B->>L: POST /api/login/start
    L->>E: createPresentationRequest (client_credentials token)
    E-->>L: requestId + QR code + deep-link URL
    L->>L: Store pending session in DynamoDB (TTL 10 min)
    L-->>B: requestId + QR code

    loop Poll every 2 seconds
        B->>L: GET /api/login/status/{requestId}
        L-->>B: {status: "pending"}
    end

    B->>B: Display QR code
    A->>E: Scan QR → present VerifiedEmployee credential
    E->>L: POST /api/login/callback (webhook, x-api-key validated)
    L->>L: Validate state, store claims → pending → success

    B->>L: GET /api/login/status/{requestId}
    L->>L: Atomic transition success → claimed
    L-->>B: {status: "success", claims: {displayName, mail, ...}}
```

### Issuance flow (credential enrolment)

```mermaid
sequenceDiagram
    participant B as Browser
    participant L as Lambda
    participant E as Entra VID
    participant A as Authenticator

    B->>L: POST /api/issue/start
    L->>E: createIssuanceRequest (client_credentials token)
    E-->>L: requestId + QR code
    L-->>B: requestId + QR code
    B->>B: Display QR code

    A->>E: Scan QR → authenticate against Entra tenant
    E->>L: POST /api/issue/callback (requestStatus: request_retrieved)
    L->>L: Update status → request_retrieved

    loop Poll
        B->>L: GET /api/login/status/{requestId}
        L-->>B: {status: "request_retrieved"}
    end

    E->>A: Issue VerifiedEmployee credential to wallet
    E->>L: POST /api/issue/callback (requestStatus: issuance_successful)
    L->>L: Update status → issuance_successful

    B->>L: GET /api/login/status/{requestId}
    L-->>B: {status: "issuance_successful"}
    B->>B: Show success screen
```

### Session state machine

```mermaid
stateDiagram-v2
    direction LR
    [*] --> pending : Request created
    pending --> request_retrieved : User scanned QR
    request_retrieved --> success : Credential verified
    request_retrieved --> failed : Verification error
    success --> claimed : Claims returned to app
    pending --> failed : Timeout / error
    claimed --> [*]
    failed --> [*]
```

---

## SAML IdP

### Flow

```mermaid
sequenceDiagram
    participant SP as Service Provider\n(AppStream etc.)
    participant L as Lambda (saml_idp)
    participant B as Browser
    participant VID as VID Flow

    SP->>L: GET /api/saml/sso?SAMLRequest=...
    L->>L: Parse AuthnRequest\nCreate SAML session in DynamoDB
    L-->>B: Redirect to /saml?session={id}

    B->>VID: Standard presentation flow\n(QR scan → credential verified)
    VID-->>B: VID requestId confirmed

    B->>L: GET /api/saml/complete?session={id}&vid={requestId}
    L->>L: Build signed SAML assertion\n(RSA-PKCS1v15 + SHA-256 + exclusive C14N)
    L-->>B: {samlResponse, acsUrl, relayState}

    B->>SP: Auto-POST SAMLResponse to ACS URL
    SP-->>B: Grant access / redirect to app
```

For landing-page initiated flows (no SP redirect), the browser calls `/api/saml/initiate?app={appId}` to create the session without an `AuthnRequest`.

### Adding a SAML application

**Step 1 — Create the IAM SAML provider** (one per deployment, shared across all apps)

1. Admin console → SAML Applications → **Download IdP Metadata**
2. AWS IAM Console → Identity providers → Add provider → SAML → upload the XML
3. Note the provider ARN: `arn:aws:iam::{account}:saml-provider/{name}`

**Step 2 — Create an IAM role with the following trust policy:**

```json
{
  "Effect": "Allow",
  "Principal": {
    "Federated": "arn:aws:iam::{account}:saml-provider/{name}"
  },
  "Action": "sts:AssumeRoleWithSAML",
  "Condition": {
    "StringEquals": {
      "SAML:aud": "https://signin.aws.amazon.com/saml"
    }
  }
}
```

**Step 3 — Add the app in the admin console**

Admin console → SAML Applications → Add App. The app tile appears on the public landing page immediately.

> **After key rotation:** Re-download IdP metadata and re-upload to your IAM SAML provider. The old certificate will no longer be valid for signature verification.

---

## Admin Console

Accessible from VPN only (WAF blocks all other traffic). URL is printed by `deploy.sh` after deployment.

### Onboarding wizard

Run once on first access. Six steps collect all required configuration. Progress is saved between steps. The wizard locks permanently after completion — use System Config for post-setup edits.

### Pages

| Page | Purpose |
|---|---|
| **Dashboard** | System status, SAML app count, active sessions, signing key age, recent audit events |
| **SAML Applications** | Add/edit/disable apps; download IdP metadata; copy metadata URL |
| **Sessions** | Active in-flight VID sessions (users mid-authentication); revoke stuck sessions |
| **Signing Keys** | Current key ID, JWKS URL, key rotation (grace window keeps old key valid) |
| **System Config** | All configuration grouped by category; inline editing for editable keys |
| **Audit Log** | Admin action trail + container runtime logs (health checks filtered) |

---

## Signing Keys

### What is signed

Every SAML assertion is signed with an RSA-2048 private key. The corresponding public certificate is published in the JWKS and in the IdP metadata that SPs use to verify signatures.

### Key storage

| Item | Location |
|---|---|
| Private key PEM | Secrets Manager → `eamSigningKey` |
| Public JWKS | S3 hosting bucket → `.well-known/jwks.json` |
| OIDC discovery | S3 hosting bucket → `.well-known/openid-configuration` |
| Key ID (kid) | SystemConfig DynamoDB → `kid` |

### Rotation

Admin console → Signing Keys → **Rotate Keys**.

A new RSA-2048 keypair is generated. The JWKS is updated with **both old and new keys** during a grace window so existing sessions remain valid. After rotation, download fresh IdP metadata from the admin console and re-upload to your AWS IAM SAML provider.

---

## Security model

### Webhook authentication

All Entra VID callbacks include an `x-api-key` header. The `callbackSecret` is validated using **constant-time comparison** to prevent timing attacks. Auto-generated during setup (32 bytes, URL-safe base64).

### Admin console authentication

- **Argon2id** password hashing (memory-hard, GPU-resistant)
- **TOTP MFA** enforced after initial password change
- **JWT cookies** — `HttpOnly`, `SameSite=Lax`; `Secure` flag when HTTPS is configured
- **Brute force protection** — 5 failed attempts → 15-minute account lock
- **Network** — internal ALB + WAF IP allowlist; no public path exists

### Lambda IAM (least privilege)

Lambdas share a single IAM role scoped to:
- DynamoDB: `GetItem`, `PutItem`, `UpdateItem`, `Query` on specific table ARNs
- Secrets Manager: `GetSecretValue` on the app secret ARN only
- S3: `GetObject` on the hosting bucket (for SAML signing certificate)

### SAML XML signing

- **Algorithm:** RSA-PKCS1v15 + SHA-256
- **Canonicalisation:** Exclusive C14N via `lxml`
- **ACS URL:** always read from DynamoDB — never taken from the incoming `AuthnRequest`

---

## Development

### Local setup

```bash
npm install                     # Install CDK and workspace dependencies

# Admin backend
cd admin
pip install -e ".[dev]"
uvicorn app.main:app --reload --port 8000

# Admin SPA (runs on http://localhost:3001)
cd admin/web && npm run dev

# Public frontend (runs on http://localhost:5173)
cd frontend && npm run dev
```

### Validate CDK without deploying

```bash
export CDK_DEFAULT_ACCOUNT=<account-id>
export CDK_DEFAULT_REGION=<region>
npx cdk synth --quiet
```

### TypeScript check

```bash
npx tsc --noEmit
```

### Lambda shared helpers

- `lambdas/shared/config.py` — reads SystemConfig from DynamoDB with 5-minute in-memory cache
- `lambdas/shared/secrets.py` — reads Secrets Manager with 5-minute cache; tries the Parameters and Secrets Lambda Extension first, falls back to direct boto3

---

## Troubleshooting

### "Could not start sign-in" on SAML flow
- Verify `/api/saml/initiate` is registered as an API Gateway route in `main-app-stack.ts`
- Confirm the Lambda IAM role has `s3:GetObject` on the hosting bucket (needed to read the signing certificate from S3)

### SAML signature verification fails at the SP
- Key rotation changed the signing certificate. Re-download IdP metadata from the admin console and re-upload to your AWS IAM SAML provider.

### Admin console login signs out immediately
- `SECURE_COOKIE=true` but the admin ALB is HTTP-only. Ensure `SECURE_COOKIE=false` is set in the ECS container environment (controlled by `hasCustomDomain` in `admin-stack.ts`).

### "System configuration not initialised" from Lambdas
- The onboarding wizard has not been completed. Open the admin console and run through all steps.
- Verify `onboarding_complete = true` exists in the `EntraVerifiedIDSystemConfig-{stage}` DynamoDB table.

### SAML metadata download returns 503
- The signing key wizard step was not completed — no JWKS file exists in S3.
- Confirm the Lambda has `s3:GetObject` permission on `.well-known/jwks.json` in the hosting bucket.

### API calls return 403 from CloudFront
- Nginx is forwarding `Host: {your-domain}` to API Gateway (which doesn't recognise that hostname).
- The Nginx proxy config must use `proxy_set_header Host $proxy_host;` not `$http_host`.

### Admin audit log page returns 500
- The admin ECS task role is missing `dynamodb:Query`. Confirm `tables.auditLog.grantReadWriteData(taskRole)` is present in `admin-stack.ts`.

---

## Project structure

```
v2/
├── bin/app.ts                    CDK entry — context-driven, zero hardcoded values
├── lib/
│   ├── data-stack.ts             DynamoDB, Secrets Manager, S3
│   ├── layers-stack.ts           Lambda layer (Docker build)
│   ├── main-app-stack.ts         Lambda functions + API Gateway routes
│   ├── public-frontend-stack.ts  ECS Fargate + internal ALB + CloudFront VPC Origin
│   └── admin-stack.ts            Admin ECS Fargate + internal ALB + WAF
├── lambdas/
│   ├── shared/                   config.py + secrets.py (TTL-cached)
│   ├── login_start/              Presentation request creation
│   ├── login_callback/           Presentation webhook receiver
│   ├── login_status/             Status polling endpoint
│   ├── issue_start/              Issuance request creation
│   ├── issue_callback/           Issuance webhook receiver
│   └── saml_idp/                 SAML 2.0 IdP
├── frontend/
│   ├── src/pages/                Landing, Login, Issue, Saml
│   └── nginx.conf                API proxy + health endpoint
├── admin/
│   ├── app/routes/               auth, setup, saml_apps, sessions, keys, config, audit
│   ├── app/services/             key_service, setup_service
│   └── web/src/pages/            Dashboard, SamlApps, Sessions, Keys, Config, Audit
├── layer/Dockerfile              Lambda layer build
├── shared-ui/src/                Shared MUI theme + components
└── deploy.sh                     Interactive deployment script
```

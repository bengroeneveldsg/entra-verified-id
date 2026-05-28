# Entra Verified ID — Technical Reference

| | |
|---|---|
| **Version** | 1.0.0 |
| **Date** | 2026-05-28 |
| **Author** | Ben Groeneveld |
| **Status** | Living document — update when architecture or behaviour changes |

---

## Revision History

| Version | Date | Author | Changes |
|---------|------|--------|---------|
| 1.0.0 | 2026-05-28 | Ben Groeneveld | Initial release |

---

## Table of Contents

1. [System Overview](#1-system-overview)
2. [Architecture](#2-architecture)
3. [AWS Services Reference](#3-aws-services-reference)
4. [CDK Stack Breakdown](#4-cdk-stack-breakdown)
5. [Network Topology](#5-network-topology)
6. [Lambda Functions — Deep Technical](#6-lambda-functions--deep-technical)
7. [Data Layer — DynamoDB Schema](#7-data-layer--dynamodb-schema)
8. [Secrets Manager Schema](#8-secrets-manager-schema)
9. [Configuration Management](#9-configuration-management)
10. [API Gateway Routes](#10-api-gateway-routes)
11. [Frontend — React SPA on ECS Fargate](#11-frontend--react-spa-on-ecs-fargate)
12. [Admin Console](#12-admin-console)
13. [SAML 2.0 IdP](#13-saml-20-idp)
14. [External Service Integrations](#14-external-service-integrations)
15. [Security Design](#15-security-design)
16. [Prerequisites](#16-prerequisites)
17. [Deployment Process](#17-deployment-process)
18. [Operational Reference](#18-operational-reference)

---

## 1. System Overview

Entra Verified ID is a production AWS deployment that implements **passwordless QR-code authentication** using Microsoft Entra Verified ID digital credentials. Users open Microsoft Authenticator, scan a QR code displayed in a browser, and their VerifiedEmployee credential is presented to the system — no password required.

### Authentication Flows

The system supports three distinct flows:

1. **Direct login** — user visits a login page, scans QR, and receives a session (e.g. for `your-app.example.com`)
2. **Credential issuance** — user scans QR to add the VerifiedEmployee credential to their Authenticator wallet
3. **SAML IdP** — SAML-federated apps (Amazon WorkSpaces, Kiro) redirect to this system as an IdP; user scans QR to authenticate

---

## 2. Architecture

### High-Level Diagram

```
User browser
     │
     ▼
┌─────────────────────────────────────────────────────────────────────┐
│  CloudFront ({cloudfront-distribution-id})                                        │
│  • TLS termination, caching, WAF-light                              │
│  • Behaviour /api/*  → API Gateway (HTTP API) origin                │
│  • Behaviour /.well-known/* → S3 WellKnown bucket (OAC)            │
│  • Default behaviour → internal ALB VPC Origin                      │
└──────────────────────────────────────────────────────────────────────
            │                                   │
            ▼ VPC Origin ({cloudfront-vpc-origin-prefix-list-id})           ▼ S3 OAC
   ┌─────────────────┐                 ┌─────────────────────┐
   │  Internal ALB   │                 │  S3 WellKnown bucket │
   │  (private VPC)  │                 │  (JWKS, DID, OIDC)  │
   └─────────────────┘                 └─────────────────────┘
            │
            ▼
   ┌─────────────────────────────┐
   │  ECS Fargate                │
   │  Nginx + React SPA          │
   │  (2 tasks, private subnets) │
   │  Proxies /api/* → API GW    │
   └─────────────────────────────┘
            │ /api/* proxy
            ▼
   ┌─────────────────────────────┐      Microsoft Entra Verified ID
   │  API Gateway HTTP API       │◄────► verifiedid.did.msidentity.com
   │  throttle: 100 rps / 200b  │      (webhook callbacks via HTTPS)
   └─────────────────────────────┘
            │
            ▼
   ┌─────────────────────────────────────────────────┐
   │  Lambda Functions (Python 3.12, x86_64)         │
   │  login_start  login_callback  login_status      │
   │  issue_start  issue_callback  saml_idp          │
   └─────────────────────────────────────────────────┘
            │                │
            ▼                ▼
   ┌──────────────┐  ┌──────────────────┐
   │  DynamoDB    │  │  Secrets Manager │
   │  5 tables    │  │  3 secrets       │
   └──────────────┘  └──────────────────┘

Admin path (internal network only):
   Internal network → WAF → Internal ALB (admin VPC) → ECS Fargate (FastAPI + React admin)
```

### Request Flow — Login

```
1. Browser           POST /api/login/start
2. login_start       → Fetch creds (Secrets Manager, cached 5 min)
                     → Fetch config (DynamoDB SystemConfig, cached 5 min)
                     → POST token endpoint → Azure AD access token
                     → POST createPresentationRequest → { requestId, qrCode, url }
                     → DynamoDB PUT { requestId, status=pending, ttl=now+600 }
                     ← Return { requestId, qrCode, url }
3. Browser           Renders QR code; begins polling every 2 s
4. MS Authenticator  User scans QR; Authenticator presents credential to Entra
5. Entra VID         POST /api/login/callback  (webhook, x-api-key header)
6. login_callback    → Constant-time key validation
                     → DynamoDB conditional UPDATE status=success, claims={…}
7. Browser           GET /api/login/status/{requestId}
8. login_status      → DynamoDB GET; if status=success → conditional UPDATE to claimed
                     ← Return { status: success, claims: {…}, subject: "did:…" }
9. Browser           Receives claims, establishes application session
```

---

## 3. AWS Services Reference

**AWS Account:** `{aws-account-id}`  
**Primary Region:** `{aws-region}`

This section explains each AWS service used in the project — what the service is, and the specific role it plays here.

---

### Amazon CloudFront

**What it is:** CloudFront is AWS's global Content Delivery Network (CDN). It sits in front of your origin servers and serves requests from the AWS edge location closest to the user. Beyond caching, it handles TLS termination, enforces HTTPS, and can route different URL paths to different origins.

**How we use it:**

- **Single public entry point** for all user traffic — the only resource with a public internet-facing address. No ALB or API Gateway endpoint is directly exposed.
- **VPC Origin** connects CloudFront to the internal frontend ALB inside the private VPC. This is what allows an ALB with no public IP to serve internet traffic; CloudFront routes requests into the VPC over AWS's private backbone using prefix list `{cloudfront-vpc-origin-prefix-list-id}`.
- **S3 Origin with OAC (Origin Access Control)** serves `/.well-known/*` documents (JWKS, DID document, OIDC discovery) directly from S3 without exposing the bucket publicly.
- **TLS termination** — users connect over HTTPS. CloudFront holds the public ACM certificate and enforces HTTPS-only.

**Resource:** Distribution ID `{cloudfront-distribution-id}`

---

### Amazon ECS Fargate

**What it is:** ECS (Elastic Container Service) is AWS's container orchestration platform. Fargate is the serverless compute engine for ECS — you provide a Docker image and resource requirements, and AWS runs the container without you managing the underlying EC2 instances. ECS handles scheduling, health checks, and rolling deployments.

**How we use it:**

- **Public frontend service** — runs the Nginx + React SPA container. Two tasks spread across two AZs for availability. Sits in private subnets behind the internal ALB.
- **Admin console service** — runs the FastAPI + React admin container. Two tasks in private subnets of the admin VPC, behind its own internal ALB and WAF.

Both services use rolling deployments: when a new image is pushed, ECS starts the new tasks, waits for them to pass health checks, then terminates the old ones — no downtime.

---

### Application Load Balancer (ALB)

**What it is:** An ALB is a Layer 7 (HTTP/HTTPS) load balancer that distributes incoming requests across a group of targets (in our case, Fargate tasks). It performs health checks, drains connections from unhealthy targets, and provides a stable DNS name regardless of which tasks are currently running.

**How we use it:**

- **Frontend ALB** (internal, no public IP) — receives traffic from CloudFront via VPC Origin and forwards it to the Nginx Fargate tasks. Security group allows inbound only from the CloudFront prefix list.
- **Admin ALB** (internal, no public IP) — receives traffic from the WAF and forwards it to the FastAPI Fargate tasks. Only reachable from within the corporate internal network (office via Direct Connect, site-to-site VPN, or client VPN).

Both ALBs are HTTP-only at the ALB level (TLS is terminated at CloudFront (for frontend) and at the internal network boundary (for admin)). This is intentional for the current deployment; ACM certificates for {aws-region} have not yet been provisioned.

---

### AWS WAF (Web Application Firewall)

**What it is:** WAF is a firewall that inspects HTTP/HTTPS requests before they reach your application. Rules can block by IP address, geographic region, request patterns, or managed rule groups (e.g. OWASP Top 10). It attaches to CloudFront, ALBs, or API Gateway.

**How we use it:**

- Attached to the **admin ALB only**.
- A single IP allowlist rule restricts access to the corporate internal network CIDR block (covering office networks connected via Direct Connect, site-to-site VPN, or client VPN connections). Any request from an IP not in that range is blocked with HTTP 403 before it reaches the Fargate container.
- This means the admin console has no public route even though the ALB is technically accessible from within the VPC — the WAF is the network-layer enforcement point.

---

### Amazon API Gateway (HTTP API)

**What it is:** API Gateway is a managed service for building and publishing APIs. The HTTP API variant (v2) is a lightweight, low-latency offering — it handles routing, throttling, CORS, and payload transformation, then invokes a Lambda function for each matching request.

**How we use it:**

- **Named:** `EntraVerifiedID-{stage}`
- Routes all `/api/*` requests to the appropriate Lambda function (see [Section 10](#10-api-gateway-routes) for the full route table).
- Configured with **throttling**: 100 requests per second sustained, 200 burst. This protects the Lambda functions from traffic spikes and limits the blast radius of any abuse.
- **CORS** is configured at the API level, restricting `allowOrigins` to the public domain when one is set.
- Uses **payload format version 2.0**, which changes the shape of the `event` dict received by Lambda (uses `requestContext.http.method` instead of `httpMethod`, etc.).

The API Gateway endpoint URL is not exposed directly — the Nginx container proxies `/api/*` requests to it internally.

---

### AWS Lambda

**What it is:** Lambda is AWS's serverless compute service. You upload code (or a container image), define a handler function, and Lambda runs it in response to events. Lambda automatically scales — each request gets its own execution environment (sandbox), up to a configurable concurrency limit. You pay only for the time your code runs, in 1 ms increments.

**How we use it:**

All business logic lives in Lambda. There are six functions, all Python 3.12 on x86_64:

| Function | Route | Role |
|----------|-------|------|
| `EntraVerifiedID-LoginStart-{stage}` | `POST /api/login/start` | Creates the Verified ID presentation request; returns QR code |
| `EntraVerifiedID-LoginCallback-{stage}` | `POST /api/login/callback` | Receives Entra webhook; writes verified claims to DynamoDB |
| `EntraVerifiedID-LoginStatus-{stage}` | `GET /api/login/status/{requestId}` | Browser polls this; atomically hands off claims on first success |
| `EntraVerifiedID-IssueStart-{stage}` | `POST /api/issue/start` | Creates the Verified ID issuance request |
| `EntraVerifiedID-IssueCallback-{stage}` | `POST /api/issue/callback` | Receives issuance webhook; updates DynamoDB |
| `EntraVerifiedID-SamlIdp-{stage}` | `GET\|POST /api/saml/*` | Full SAML 2.0 IdP — metadata, SSO, assertion signing |

Each function runs in a **shared IAM role** (`EntraVerifiedID-Lambda-{stage}`) with least-privilege grants to DynamoDB, Secrets Manager, and S3. X-Ray tracing is enabled on all functions.

Lambda **cold starts** (first invocation after a sandbox is created) add ~500–800 ms for Python with the cryptography layer. Subsequent warm invocations are typically under 100 ms.

---

### AWS Lambda Layers

**What it is:** A Lambda Layer is a zip archive of libraries, binaries, or other dependencies that can be shared across multiple Lambda functions. The layer is mounted at `/opt` in the Lambda execution environment, making its contents available to the function code. Using a layer keeps the function deployment package small and allows library updates without redeploying every function.

**How we use it:**

A single layer (`EntraVid-CryptoLayer-{stage}`) is built from a Docker image (`layer/Dockerfile`) and contains:
- **`cryptography`** — RSA-2048 key generation, RSA-PKCS1v15 signing, X.509 certificate handling. Used by `saml_idp` to sign SAML assertions.
- **`lxml`** — XML parsing and exclusive C14N canonicalisation required by the XML-DSig specification used in SAML. The standard Python `xml` library does not implement C14N correctly.
- **`aws-lambda-powertools`** — structured JSON logging (all log entries include `request_id`, `cold_start`, `service`), X-Ray tracing decorators.

Only the `saml_idp` function uses the layer. The other five functions run without it (smaller deployment package, faster cold start).

---

### Amazon DynamoDB

**What it is:** DynamoDB is AWS's fully managed, serverless NoSQL database. It stores data as items in tables; each item is a collection of attributes. Tables scale automatically (pay-per-request billing mode) and replicate across multiple AZs for durability. DynamoDB's TTL feature automatically deletes items past a specified expiry time.

**How we use it:**

Five tables, all in on-demand (pay-per-request) billing mode with point-in-time recovery enabled:

| Table | Primary key | Purpose |
|-------|------------|---------|
| `EntraVerifiedID-{stage}` | `requestId` | Tracks the state of every presentation/issuance request |
| `VerifiedIDSamlApps-{stage}` | `appId` | Stores SAML service provider configurations |
| `EntraVerifiedIDSystemConfig-{stage}` | `pk` + `sk` | All non-secret runtime configuration |
| `EntraVerifiedIDAdminUsers-{stage}` | `username` | Admin console user accounts and MFA state |
| `EntraVerifiedIDAuditLog-{stage}` | `pk` + `sk` | Immutable audit trail (90-day TTL) |

The **state table** is the heart of the auth flow: `login_start` writes a pending record, `login_callback` updates it to `success` using a conditional write (idempotency), and `login_status` atomically transitions it to `claimed` on first read. DynamoDB's conditional expressions make these atomic without any application-level locking.

---

### AWS Secrets Manager

**What it is:** Secrets Manager is a service for storing, rotating, and retrieving secrets (API keys, passwords, database credentials). Secrets are encrypted at rest using KMS. Applications retrieve secrets via API call at runtime rather than baking them into config files or environment variables.

**How we use it:**

Three secrets:

| Secret | Contents | Lifecycle |
|--------|----------|-----------|
| `EntraVerifiedID/{stage}/app` | Entra client ID/secret, callback secret, RSA signing key | Written by admin setup wizard |
| `EntraVerifiedID/{stage}/bootstrap-admin` | One-time admin password | Auto-generated by CDK; consumed once |
| `EntraVerifiedID/{stage}/jwt-signing-key` | HMAC-SHA256 key for admin session JWTs | Auto-generated by CDK |

Lambda functions retrieve secrets via the **Lambda Extensions Secrets Manager sidecar** (a local HTTP server on port 2773) rather than calling the Secrets Manager API directly. The sidecar caches the secret in the Lambda sandbox, eliminating a network call on warm invocations. A 5-minute TTL in the Lambda code on top of the sidecar cache means at most one sidecar call per 5 minutes per sandbox.

---

### Amazon S3 (Simple Storage Service)

**What it is:** S3 is AWS's object storage service. Objects (files) are stored in buckets. S3 is highly durable (11 nines), supports versioning, and can serve objects directly over HTTPS. Access is controlled via bucket policies and IAM; buckets can be kept entirely private with no public access.

**How we use it:**

Two private buckets:

| Bucket | Contents | Accessed by |
|--------|----------|-------------|
| `entra-vid-hosting-{account}-{stage}` | JWKS, OIDC discovery doc, DID document | Lambda (`saml_idp` reads JWKS to get the signing cert); also mirrored to well-known bucket |
| `entra-vid-well-known-{account}-{stage}` | Same JWKS/DID/OIDC documents | CloudFront OAC → served at `/.well-known/*` |

Both buckets have public access fully blocked. The well-known bucket is accessed by CloudFront using OAC (Origin Access Control), which grants CloudFront permission via a bucket policy without any public endpoint. Versioning is enabled on the hosting bucket for key rotation rollback safety.

---

### Amazon ECR (Elastic Container Registry)

**What it is:** ECR is AWS's managed Docker container registry. It stores Docker images that ECS pulls when launching Fargate tasks. Images are encrypted at rest and access is controlled via IAM.

**How we use it:**

CDK builds two Docker images at deploy time and pushes them to ECR:
- **Frontend image** — Nginx + compiled React SPA (multi-stage build: Node for Vite build, nginx:alpine for runtime)
- **Admin image** — FastAPI backend + compiled React admin SPA

ECS Fargate pulls these images from ECR when launching tasks. The admin VPC has no IGW, so ECR pulls route through Cloud WAN egress (or could use an ECR VPC endpoint). The frontend VPC has an IGW and uses `assignPublicIp: true` for ECR pulls.

---

### Amazon CloudWatch Logs

**What it is:** CloudWatch Logs is AWS's centralised log aggregation service. It collects logs from Lambda, ECS, API Gateway, and other services into named log groups. Logs are retained for a configurable period, are searchable, and can trigger alarms or metric filters.

**How we use it:**

All Lambda functions write structured JSON logs via `aws-lambda-powertools.Logger`. Every log entry automatically includes `request_id`, `cold_start`, `service`, and `level`. ECS tasks write container stdout to log groups.

| Log group | Source |
|-----------|--------|
| `/aws/lambda/EntraVerifiedID-LoginStart-{stage}` | login_start Lambda |
| `/aws/lambda/EntraVerifiedID-LoginCallback-{stage}` | login_callback Lambda |
| `/aws/lambda/EntraVerifiedID-LoginStatus-{stage}` | login_status Lambda |
| `/aws/lambda/EntraVerifiedID-IssueStart-{stage}` | issue_start Lambda |
| `/aws/lambda/EntraVerifiedID-IssueCallback-{stage}` | issue_callback Lambda |
| `/aws/lambda/EntraVerifiedID-SamlIdp-{stage}` | saml_idp Lambda |
| `/ecs/entra-vid-frontend-{stage}` | Frontend Fargate tasks |
| `/ecs/entra-vid-admin-{stage}` | Admin Fargate tasks |

---

### AWS X-Ray

**What it is:** X-Ray is AWS's distributed tracing service. When enabled, it records timing data for each component a request passes through — API Gateway, Lambda invocation, SDK calls to DynamoDB and Secrets Manager — and assembles these into a trace that can be viewed in the X-Ray service map or trace explorer.

**How we use it:**

X-Ray active tracing (`lambda.Tracing.ACTIVE`) is enabled on all six Lambda functions. This means every Lambda invocation generates a trace segment, and any downstream AWS SDK calls (DynamoDB `get_item`, Secrets Manager `get_secret_value`) appear as sub-segments with their own latency measurements. Useful for diagnosing cold starts, identifying slow DynamoDB queries, and understanding latency distributions.

---

### AWS Route 53

**What it is:** Route 53 is AWS's managed DNS service. It hosts DNS zones and records, and integrates natively with other AWS services (CloudFront, ALB, API Gateway) via Alias records.

**How we use it (optional):**

When a custom domain is configured, CDK can create CNAME records pointing `api.{publicDomain}` at the API Gateway regional domain. Route 53 is optional — the deployment functions with default API Gateway and CloudFront URLs.

> **Current deployment:** The Route 53 zone is in a separate networking account. DNS records are added manually rather than by CDK.

---

### AWS Certificate Manager (ACM)

**What it is:** ACM provisions and manages TLS/SSL certificates. Certificates issued by ACM are free, auto-renewed, and can be attached to CloudFront distributions, ALBs, and API Gateway custom domains. CloudFront requires certificates to be in `us-east-1`; all other services use the certificate in the deployment region.

**How we use it (optional):**

- **`us-east-1` certificate** — attached to the CloudFront distribution for the custom domain (e.g. `vid.example.com`)
- **Regional certificate** (`{aws-region}`) — attached to the API Gateway custom domain (`api.vid.example.com`)

> **Current deployment:** No ACM certificates have been provisioned in {aws-region} yet. Both ALBs are HTTP-only; TLS is handled at CloudFront (for frontend) and at the internal network boundary (for admin).

---

### Quick-Reference Summary

| Service | What it is (one line) | Our resource(s) |
|---------|----------------------|-----------------|
| **CloudFront** | Global CDN + TLS termination | Distribution `{cloudfront-distribution-id}` |
| **ECS Fargate** | Serverless container runtime | 2 services (frontend + admin) |
| **ALB** | Layer 7 load balancer | 2 internal ALBs |
| **WAF** | HTTP firewall / IP allowlist | Admin ALB only |
| **API Gateway** | Managed HTTP API router | `EntraVerifiedID-{stage}` HTTP API |
| **Lambda** | Serverless function compute | 6 functions (Python 3.12) |
| **Lambda Layer** | Shared library package | `cryptography`, `lxml`, `powertools` |
| **DynamoDB** | Serverless NoSQL database | 5 tables |
| **Secrets Manager** | Encrypted secret store | 3 secrets |
| **S3** | Object storage | 2 private buckets |
| **ECR** | Docker image registry | 2 images (frontend, admin) |
| **CloudWatch Logs** | Centralised log aggregation | 8 log groups |
| **X-Ray** | Distributed tracing | Lambda active tracing |
| **Route 53** | Managed DNS | Optional — manual in this deployment |
| **ACM** | TLS certificate management | Optional — not yet provisioned |

---

## 4. CDK Stack Breakdown

The deployment is split into five CDK stacks. They must be deployed in dependency order; CDK handles this automatically.

```
EntraVid-Data-{stage}
    └── EntraVid-Layers-{stage}
            └── EntraVid-MainApp-{stage}
                    ├── EntraVid-PublicFrontend-{stage}
                    └── EntraVid-Admin-{stage}
```

### 4.1 Data Stack (`EntraVid-Data-{stage}`)

**File:** `lib/data-stack.ts`

Creates all stateful resources. All DynamoDB tables use `RETAIN` removal policy — they survive `cdk destroy`.

```typescript
// All tables share these baseline properties
const commonTableProps: Partial<dynamodb.TableProps> = {
  billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,  // on-demand, no capacity planning
  pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: true },
  encryption: dynamodb.TableEncryption.AWS_MANAGED,
  removalPolicy: cdk.RemovalPolicy.RETAIN,
};
```

| Resource | Type | Name pattern | Notes |
|----------|------|-------------|-------|
| `StateTable` | DynamoDB | `EntraVerifiedID-{stage}` | PK=`requestId`, TTL=`ttl` |
| `SamlAppsTable` | DynamoDB | `VerifiedIDSamlApps-{stage}` | PK=`appId` |
| `SystemConfigTable` | DynamoDB | `EntraVerifiedIDSystemConfig-{stage}` | PK=`pk`, SK=`sk` |
| `AdminUsersTable` | DynamoDB | `EntraVerifiedIDAdminUsers-{stage}` | PK=`username` |
| `AuditLogTable` | DynamoDB | `EntraVerifiedIDAuditLog-{stage}` | PK=`pk`, SK=`sk`, TTL=`expires_at` |
| `AppSecret` | Secrets Manager | `EntraVerifiedID/{stage}/app` | Populated by wizard post-deploy |
| `BootstrapAdminSecret` | Secrets Manager | `EntraVerifiedID/{stage}/bootstrap-admin` | 32-char random, consumed once |
| `JwtSigningSecret` | Secrets Manager | `EntraVerifiedID/{stage}/jwt-signing-key` | 64-char HMAC key, auto-generated |
| `HostingBucket` | S3 | `entra-vid-hosting-{account}-{stage}` | Private, versioned, SSL-enforced |

### 4.2 Layers Stack (`EntraVid-Layers-{stage}`)

**File:** `lib/layers-stack.ts`

Builds a Lambda layer from a Docker image (`layer/Dockerfile`) containing:
- `cryptography` — RSA key generation, RSA signing, X.509 certificates
- `lxml` — XML parsing and exclusive C14N for SAML assertion signing
- `aws-lambda-powertools` — structured logging, tracing, middleware

The layer is built using CDK's `DockerImageCode` so it is always current with library versions pinned in `requirements.txt`.

### 4.3 Main App Stack (`EntraVid-MainApp-{stage}`)

**File:** `lib/main-app-stack.ts`

Contains all Lambda functions and the API Gateway HTTP API. All six functions share a single IAM execution role (`EntraVerifiedID-Lambda-{stage}`) with least-privilege grants:

```typescript
tables.stateTable.grantReadWriteData(lambdaRole);   // login/issue flows read+write
tables.samlAppsTable.grantReadData(lambdaRole);      // SAML IdP reads app config
tables.systemConfig.grantReadData(lambdaRole);       // All functions read config
appSecret.grantRead(lambdaRole);                     // All functions read secrets
hostingBucket.grantRead(lambdaRole);                 // SAML IdP reads JWKS cert
```

**Lambda default settings (applied via helper function):**

```typescript
const fn = (id: string, entry: string, extraEnv?: Record<string, string>, useCrypto = false) => {
  return new python.PythonFunction(this, id, {
    runtime:      lambda.Runtime.PYTHON_3_12,
    architecture: lambda.Architecture.X86_64,
    memorySize:   useCrypto ? 512 : 256,   // 512 MB for crypto-heavy functions
    timeout:      cdk.Duration.seconds(30),
    tracing:      lambda.Tracing.ACTIVE,   // X-Ray enabled
    layers:       useCrypto ? [cryptoLayer] : [],
    environment:  { ...sharedEnv, ...extraEnv },
  });
};
```

The `saml_idp` function is the only one that receives `useCrypto = true`.

**API Gateway configuration:**

```typescript
const httpApi = new apigwv2.HttpApi(this, 'HttpApi', {
  corsPreflight: {
    allowOrigins: publicDomain ? [`https://${publicDomain}`] : ['*'],
    allowMethods: [GET, POST, OPTIONS],
    allowHeaders: ['content-type', 'x-api-key'],
    maxAge:       cdk.Duration.days(1),
  },
});
httpApi.addStage('DefaultStage', {
  stageName:  '$default',
  autoDeploy: true,
  throttle: { burstLimit: 200, rateLimit: 100 },  // 100 rps sustained, 200 burst
});
```

### 4.4 Public Frontend Stack (`EntraVid-PublicFrontend-{stage}`)

**File:** `lib/public-frontend-stack.ts`

Builds a React SPA Docker image and deploys it to ECS Fargate behind an **internal** ALB. CloudFront sits in front with a VPC Origin pointing at the ALB. No internet-facing ALB exists.

Key design decisions:
- ALB security group allows inbound only from CloudFront VPC Origins prefix list (`{cloudfront-vpc-origin-prefix-list-id}` in {aws-region})
- Fargate tasks run in private subnets with `assignPublicIp: true` — this is because the frontend VPC (`{frontend-vpc-id}`) has an IGW, which is required for the CloudFront VPC Origin feature
- A second S3 bucket (`WellKnownBucket`) is created in this stack and connected to CloudFront via OAC for serving `/.well-known/*` documents (JWKS, DID, OIDC discovery)

### 4.5 Admin Stack (`EntraVid-Admin-{stage}`)

**File:** `lib/admin-stack.ts`

Deploys the FastAPI admin console to ECS Fargate in the admin VPC (`{admin-vpc-id}`). An AWS WAF Web ACL with an IP allowlist (internal network CIDR) guards the internal ALB — no request reaches the container without first passing WAF.

- Fargate tasks use `assignPublicIp: false`; ECR image pulls route through Cloud WAN egress
- `SECURE_COOKIE=false` is currently set because the admin ALB does not have an ACM cert (HTTP only at ALB level, HTTPS terminated at the internal network boundary)

---

## 5. Network Topology

### VPC Architecture

The deployment uses two **pre-existing** VPCs. CDK does not create networking resources.

| VPC | ID | Purpose | Egress |
|-----|----|---------|--------|
| Frontend | `{frontend-vpc-id}` | Public frontend Fargate, ALB | IGW (required for VPC Origin) |
| Admin | `{admin-vpc-id}` | Admin Fargate, admin ALB | Cloud WAN |

Both VPCs have subnets in ≥2 availability zones (required for ALB).

### Security Group Chain

**Frontend path:**

```
Internet → CloudFront → [{cloudfront-vpc-origin-prefix-list-id} prefix list] → ALB SG → ALB → Fargate SG → Fargate tasks
```

- **ALB SG** (`AlbSg`): ingress TCP/80 from CloudFront prefix list
- **Fargate SG** (`FargateSg`): ingress TCP/80 from ALB SG only

**Admin path:**

```
Internal network → WAF (IP allowlist) → ALB SG → ALB → Fargate SG → Fargate tasks
```

- **ALB SG** (`AdminAlbSg`): ingress TCP/80 from internal network CIDR, TCP/80 from WAF-managed IPs
- **Fargate SG** (`AdminFargateSg`): ingress TCP/8000 from admin ALB SG only

### CloudFront Distribution

**Distribution ID:** `{cloudfront-distribution-id}`

| Behaviour | Path | Origin | Cache |
|-----------|------|--------|-------|
| Default | `/*` | Internal ALB (VPC Origin) | No cache (React SPA) |
| Well-known | `/.well-known/*` | S3 WellKnown bucket (OAC) | Cache (JWKS/DID change rarely) |

The API Gateway is not a CloudFront origin — the React SPA proxies `/api/*` requests through Nginx, which routes them to the API Gateway execute-api URL. This avoids cross-origin issues.

---

## 6. Lambda Functions — Deep Technical

All Lambda functions follow a consistent pattern:

1. **Module-level singletons** — boto3 clients, environment variable reads, TTL caches for secrets and config
2. **`_get_secret()` / `_get_config()`** — 5-minute in-memory TTL cache; primary path uses the Lambda Extensions Secrets Manager sidecar (port 2773), falls back to direct SDK call
3. **`@logger.inject_lambda_context`** — injects `request_id` and `cold_start` into all log entries
4. **Structured logging** — `aws_lambda_powertools.Logger` writes JSON to CloudWatch

### 6.1 `login_start` — `POST /api/login/start`

**File:** `lambdas/login_start/handler.py`  
**Memory:** 256 MB | **Timeout:** 30 s | **Architecture:** x86_64

**Responsibilities:**
- Authenticate to Azure AD using client credentials
- Call Entra Verified ID `createPresentationRequest`
- Persist pending state to DynamoDB
- Return QR code and request ID to the browser

**Secrets cache implementation:**

```python
_EXTENSION_PORT = "2773"

def _get_secret() -> dict[str, str]:
    global _secrets_cache, _secrets_cache_at
    now = time.time()
    if _secrets_cache is not None and (now - _secrets_cache_at) < _SECRETS_TTL:
        return _secrets_cache          # warm cache hit — zero latency
    try:
        # Primary: Lambda Extensions Secrets Manager sidecar (local HTTP, no AWS API call)
        quoted = urllib.parse.quote(_SECRET_NAME, safe="")
        req = urllib.request.Request(
            f"http://localhost:{_EXTENSION_PORT}/secretsmanager/get?secretId={quoted}",
            headers={"X-Aws-Parameters-Secrets-Token": os.environ.get("AWS_SESSION_TOKEN", "")},
        )
        with urllib.request.urlopen(req, timeout=2) as resp:
            body = json.loads(resp.read())
        data: dict[str, str] = json.loads(body["SecretString"])
    except Exception:
        # Fallback: direct Secrets Manager SDK call
        resp2 = _secrets_boto.get_secret_value(SecretId=_SECRET_NAME)
        data = json.loads(resp2["SecretString"])
    _secrets_cache = data
    _secrets_cache_at = now
    return data
```

> The primary path queries a local sidecar process (the Lambda Extensions Secrets Manager extension) which caches secrets in the Lambda sandbox. This avoids a network round-trip to the Secrets Manager control plane on warm invocations. The 5-minute TTL on the module-level cache means the sidecar is queried at most once every 5 minutes per sandbox.

**Azure AD token acquisition:**

```python
ENTRA_VID_APP_ID = "3db474b9-6a0c-4840-96ac-1fceb342124f"  # Microsoft-published constant
ENTRA_VID_SCOPE  = f"{ENTRA_VID_APP_ID}/.default"

def _get_access_token(client_id: str, client_secret: str, tenant_id: str) -> str:
    token_endpoint = f"https://login.microsoftonline.com/{tenant_id}/oauth2/v2.0/token"
    body = urllib.parse.urlencode({
        "grant_type":    "client_credentials",
        "client_id":     client_id,
        "client_secret": client_secret,
        "scope":         ENTRA_VID_SCOPE,
    }).encode()
    # ... HTTP POST, returns access_token
```

**Presentation request payload:**

```python
payload = {
    "includeQRCode": True,
    "callback": {
        "url":     f"{callback_base_url}/api/login/callback",
        "state":   request_id,                  # echoed back in webhook
        "headers": {"x-api-key": callback_secret},
    },
    "authority": authority,                      # our DID, e.g. did:web:...
    "registration": {"clientName": client_name},
    "requestedCredentials": [{
        "type":            "VerifiedEmployee",
        "purpose":         "Sign in without a password",
        "acceptedIssuers": [accepted_issuer],
        "configuration": {
            "validation": {
                "allowRevoked":         False,
                "validateLinkedDomain": True,   # validates our DID against our domain
            }
        },
    }],
}
```

**DynamoDB write:**

```python
def _store_pending_request(request_id: str) -> None:
    table = _dynamodb.Table(_STATE_TABLE)
    now = int(time.time())
    table.put_item(Item={
        "requestId": request_id,
        "state":     request_id,    # echoed back by Entra in webhook
        "status":    "pending",
        "createdAt": now,
        "ttl":       now + 600,     # 10-minute expiry
    })
```

**Response shape:**

```json
{
  "requestId": "550e8400-e29b-41d4-a716-446655440000",
  "qrCode":    "<base64-png-without-data-uri-prefix>",
  "url":       "ms-authenticator://..."
}
```

---

### 6.2 `login_callback` — `POST /api/login/callback`

**File:** `lambdas/login_callback/handler.py`  
**Memory:** 256 MB | **Timeout:** 30 s

This is the Entra Verified ID webhook receiver. Entra calls this endpoint after the user presents their credential in Authenticator.

**Security validation (constant-time key comparison):**

```python
def _validate_api_key(event: dict[str, Any], expected: str) -> bool:
    """Constant-time comparison prevents timing-based secret extraction."""
    headers: dict[str, str] = {
        k.lower(): v for k, v in (event.get("headers") or {}).items()
    }
    received = headers.get("x-api-key", "")
    if len(received) != len(expected):
        return False
    result = 0
    for a, b in zip(received.encode(), expected.encode()):
        result |= a ^ b          # XOR accumulator; non-zero means mismatch
    return result == 0
```

> Standard string comparison (`==`) short-circuits on the first differing character, leaking timing information about how much of the secret matched. The XOR accumulator continues for every byte regardless, making all comparisons take the same time.

**Idempotency guard on DynamoDB write:**

```python
def _update_record_success(request_id: str, claims: dict, subject: str) -> None:
    table.update_item(
        Key={"requestId": request_id},
        UpdateExpression="SET #st = :success, claims = :claims, #sub = :subject, updatedAt = :now",
        ConditionExpression=Attr("status").eq("pending"),  # only transitions from pending
        ExpressionAttributeNames={"#st": "status", "#sub": "subject"},
        ExpressionAttributeValues={":success": "success", ...},
    )
```

> If Entra delivers the webhook twice (which can happen), the `ConditionExpression` on the first update will succeed; the second will raise `ConditionalCheckFailedException`, which is caught and logged as an idempotency event rather than an error.

**Webhook contract:** The function always returns HTTP 200 to Entra (except 401 on key failure or 400 on unparseable body). Entra retries webhooks that receive non-2xx responses, so returning an error for a DynamoDB failure would cause repeated retries.

**Status transitions triggered by this function:**

```
pending → success    (requestStatus = "presentation_verified")
pending → failed     (requestStatus = "presentation_error")
(no-op) → (no-op)   (requestStatus = "request_retrieved", QR scanned but not yet verified)
```

---

### 6.3 `login_status` — `GET /api/login/status/{requestId}`

**File:** `lambdas/login_status/handler.py`  
**Memory:** 256 MB | **Timeout:** 30 s

Polled by the browser every 2 seconds. Returns status and, on first successful poll, the VC claims.

**Input validation:**

```python
if len(request_id) > 128 or not all(c in "-0123456789abcdefABCDEF" for c in request_id):
    return _json_response(400, {"error": "Invalid requestId format"})
```

> Restricts the DynamoDB key lookup to UUID-format strings, preventing any path traversal or injection attempt.

**Atomic claims handoff (success → claimed):**

```python
def _mark_claimed(request_id: str) -> None:
    """Atomically transition 'success' -> 'claimed' so claims are returned exactly once."""
    table.update_item(
        Key={"requestId": request_id},
        UpdateExpression="SET #st = :claimed",
        ConditionExpression=Attr("status").eq("success"),  # only if still success
        ExpressionAttributeNames={"#st": "status"},
        ExpressionAttributeValues={":claimed": "claimed"},
    )
```

> Two concurrent browser tabs or a double-submit could both read `status=success` before either writes. The conditional update ensures only one wins; the other receives `ConditionalCheckFailedException` and falls back to returning `status: pending`, causing the tab to retry. The winning tab receives the claims.

**State machine:**

```
DynamoDB status  │  HTTP response
─────────────────┼──────────────────────────────────────────
pending          │  200 { status: "pending" }
success          │  200 { status: "success", claims, subject }  + atomically → claimed
claimed          │  200 { status: "claimed" }   (second poll — browser should stop)
failed           │  200 { status: "failed", failureReason }
(not found)      │  404 { error: "Request not found or expired" }
```

---

### 6.4 `issue_start` — `POST /api/issue/start`

**File:** `lambdas/issue_start/handler.py`  
**Memory:** 256 MB | **Timeout:** 30 s

Mirrors `login_start` but calls `createIssuanceRequest` instead of `createPresentationRequest`. The Entra VerifiedEmployee manifest URL is read from `SystemConfig` (key: `manifest_url`).

**Key difference from login:** The issuance callback delivers two events:

1. `request_retrieved` — user has scanned the QR code; credential fetch is in progress
2. `issuance_successful` — credential has been added to the user's Authenticator wallet

The `login_status` handler passes `request_retrieved` and `issuance_successful` statuses through to the browser, which shows appropriate progress messages.

---

### 6.5 `issue_callback` — `POST /api/issue/callback`

**File:** `lambdas/issue_callback/handler.py`

Same validation logic as `login_callback` (constant-time key check, idempotency guard). Handles three status values:

| `requestStatus` | DynamoDB update |
|-----------------|----------------|
| `request_retrieved` | `status = "request_retrieved"` |
| `issuance_successful` | `status = "issuance_successful"`, `issuedAt = now` |
| `issuance_error` | `status = "issuance_error"`, `errorMsg = …` |

---

### 6.6 `saml_idp` — `GET|POST /api/saml/*`

**File:** `lambdas/saml_idp/handler.py`  
**Memory:** 512 MB | **Timeout:** 30 s | **Layer:** cryptography + lxml

Implements a full SAML 2.0 Identity Provider. This is the most complex Lambda in the system.

**Route dispatch:**

```python
path = event.get("rawPath", "")
method = event.get("requestContext", {}).get("http", {}).get("method", "GET")

if path == "/api/saml/metadata":
    return _handle_metadata(config)
elif path == "/api/saml/sso":
    return _handle_sso(event, config)          # GET: HTTP-Redirect binding
                                                # POST: HTTP-POST binding
elif path == "/api/saml/initiate":
    return _handle_initiate(event, config)     # IdP-initiated SSO
elif path == "/api/saml/complete":
    return _handle_complete(event, config)     # Build + sign SAML response
elif path == "/api/saml/apps":
    return _handle_apps()
```

**Module-level caches:**

```python
_secrets_cache: dict[str, str] | None = None     # 5-min TTL
_config_cache: dict[str, str] | None = None      # 5-min TTL
_app_config_cache: dict[str, tuple[dict, float]] = {}  # per-app, 5-min TTL
_cached_cert_b64: str | None = None              # lifetime of container (cert is static)
_cached_graph_token: dict | None = None          # {token, expires_at}
```

**SAML SSO flow:**

```
SP (e.g. WorkSpaces)    saml_idp Lambda            DynamoDB           Frontend
       │                      │                        │                   │
       │─ POST /saml/sso ─────►│                        │                   │
       │  (AuthnRequest)       │─ PUT saml_session ─────►│                   │
       │                       │◄─ ok ──────────────────│                   │
       │◄─ 302 /saml?session=X─│                        │                   │
       │                       │                        │◄─ GET saml/session │
       │                       │                        │   User scans QR    │
       │                       │                        │─ (login flow) ─────►│
       │                       │                        │                    │
       │◄─────────────────────────── GET /api/saml/complete ────────────────│
       │                       │◄─ complete request ────│                   │
       │                       │─ sign assertion ────────────────────────   │
       │◄─ 200 (auto-POST form)│                                            │
       │  SAMLResponse → ACS   │
```

**XML signing (critical section — do not modify):**

```python
# Uses lxml for exclusive C14N (required by SAML spec)
from lxml import etree
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import padding

def _sign_xml(xml_string: str, private_key_pem: str) -> str:
    root = etree.fromstring(xml_string.encode())
    # Exclusive C14N of the element to be signed
    c14n_bytes = _exclusive_c14n(root)
    # SHA-256 digest
    digest = hashlib.sha256(c14n_bytes).digest()
    digest_b64 = base64.b64encode(digest).decode()
    # RSA-PKCS1v15 + SHA-256 signature
    private_key = serialization.load_pem_private_key(private_key_pem.encode(), password=None)
    signature_bytes = private_key.sign(c14n_bytes, padding.PKCS1v15(), hashes.SHA256())
    signature_b64 = base64.b64encode(signature_bytes).decode()
    # Inject SignatureValue and KeyInfo into the XML
    # ... (inserts ds:Signature element with DigestValue, SignatureValue, X509Certificate)
```

> Exclusive C14N (canonical XML) is required by the XML-DSig specification used in SAML. The standard Python `xml` library does not implement C14N correctly for all cases. `lxml`'s implementation was validated against multiple SAML SPs (AWS Console, WorkSpaces) and must not be changed without extensive regression testing.

**ACS URL security:**

```python
# ACS URL is ALWAYS read from DynamoDB per-app config, never from the AuthnRequest
app_config = _get_app_config(app_id)           # DynamoDB lookup
acs_url = app_config["acsUrl"]                  # e.g. https://signin.aws.amazon.com/saml
# The ACS URL from the incoming AuthnRequest is parsed for session context only,
# never used as the redirect destination.
```

> This prevents open-redirect / assertion injection attacks where an attacker crafts an AuthnRequest with a malicious ACS URL.

**Group-based access control:**

```python
if app_config.get("allowedGroupIds"):
    user_email = claims.get("mail") or claims.get("userPrincipalName")
    member_groups = _check_graph_group_membership(user_email, app_config["allowedGroupIds"])
    if not member_groups:
        return _saml_error_response("User is not a member of any allowed group")
```

Group membership is verified via Microsoft Graph API (`/users/{email}/checkMemberObjects`) using a client credentials token scoped to `https://graph.microsoft.com/.default`.

---

## 7. Data Layer — DynamoDB Schema

### 7.1 State Table (`EntraVerifiedID-{stage}`)

**PK:** `requestId` (String, UUID)  
**TTL attribute:** `ttl` (Unix epoch seconds)

All records expire after 10 minutes unless the TTL is extended. DynamoDB's TTL cleanup may lag by up to 48 hours, but the application checks `item.ttl < now()` in code to treat any item past TTL as absent.

**Login / Issuance record:**

| Attribute | Type | Values | Set by |
|-----------|------|--------|--------|
| `requestId` | String | UUID | `login_start` |
| `state` | String | = `requestId` | `login_start` |
| `status` | String | `pending → success → claimed` or `pending → failed` | `login_callback` / `login_status` |
| `claims` | Map | `{displayName, mail, userPrincipalName, …}` | `login_callback` |
| `subject` | String | DID of the credential holder | `login_callback` |
| `failureReason` | String | Error message from Entra | `login_callback` |
| `createdAt` | Number | Unix timestamp | `login_start` |
| `updatedAt` | Number | Unix timestamp | `login_callback` |
| `ttl` | Number | `createdAt + 600` | `login_start` |
| `flow` | String | `"issuance"` (issuance records only) | `issue_start` |

**SAML session record:**

| Attribute | Type | Notes |
|-----------|------|-------|
| `requestId` | String | SAML session UUID |
| `type` | String | `"saml_session"` |
| `appId` | String | References `SamlAppsTable` |
| `vidRequestId` | String | UUID of the VID presentation request |
| `status` | String | `pending → vid_verified → complete` |
| `relayState` | String | Passed through from SP's AuthnRequest |
| `ttl` | Number | 10-minute expiry |

### 7.2 SAML Apps Table (`VerifiedIDSamlApps-{stage}`)

**PK:** `appId` (String)

| Attribute | Type | Required | Notes |
|-----------|------|----------|-------|
| `appId` | String | Yes | Unique app identifier |
| `displayName` | String | Yes | Shown in app-picker UI |
| `description` | String | No | |
| `spEntityId` | String | Yes | SAML entity ID of the service provider |
| `acsUrl` | String | Yes | Assertion Consumer Service URL |
| `relayState` | String | No | Default relay state |
| `roleArn` | String | Yes (AWS SAML) | IAM role ARN for AWS federation |
| `providerArn` | String | Yes (AWS SAML) | IAM SAML provider ARN |
| `sessionName` | String | No | Default: `VerifiedIDSession` |
| `sessionDuration` | String | No | Seconds, default `43200` (12h) |
| `allowedGroupIds` | List | No | Entra group object IDs; empty = allow all |
| `enabled` | Boolean | No | Default `true` |

### 7.3 System Config Table (`EntraVerifiedIDSystemConfig-{stage}`)

**PK:** `pk` (String) | **SK:** `sk` (String)

All config rows use `pk = "system"` with `sk` being the config key name. Written by the admin onboarding wizard, read by all Lambda functions.

| Key (`sk`) | Example value | Notes |
|------------|---------------|-------|
| `tenant_id` | `00000000-0000-0000-0000-000000000000` | Azure AD tenant GUID |
| `callback_base_url` | `https://api.vid.example.com` | API Gateway custom domain |
| `authority` | `did:web:verifiedid.entra.microsoft.com:…` | Our DID |
| `accepted_issuer` | `did:web:…` | Trusted VC issuer DID |
| `manifest_url` | `https://…/verifiedemployee` | VerifiedEmployee manifest |
| `client_name` | `My Organisation` | Shown in Authenticator |
| `public_domain` | `vid.example.com` | CloudFront domain |
| `api_domain` | `api.vid.example.com` | API Gateway domain |
| `frontend_base_url` | `https://vid.example.com` | Full public URL |
| `entity_id` | `https://vid.example.com/saml` | SAML IdP entity ID |
| `saml_sso_url` | `https://api.vid.example.com/api/saml/sso` | SAML SSO endpoint |
| `saml_jwks_url` | `https://vid.example.com/.well-known/jwks.json` | JWKS for SP to verify |
| `kid` | `AAAAAAAAAAAAAAAAAAAAAA==` | RSA key ID (base64url, SHA-1 thumbprint) |
| `key_created_at` | `1748000000` | Unix timestamp of last key rotation |

### 7.4 Admin Users Table (`EntraVerifiedIDAdminUsers-{stage}`)

**PK:** `username` (String)

| Attribute | Type | Notes |
|-----------|------|-------|
| `username` | String | Primary key |
| `password_hash` | String | Argon2id hash |
| `totp_secret` | String | TOTP seed (base32, stored post-setup) |
| `totp_enabled` | Boolean | `true` after first login + TOTP setup |
| `failed_attempts` | Number | Resets on successful login |
| `locked_until` | Number | Unix timestamp; 0 = not locked |
| `created_at` | Number | Unix timestamp |
| `last_login_at` | Number | Unix timestamp |

### 7.5 Audit Log Table (`EntraVerifiedIDAuditLog-{stage}`)

**PK:** `pk` (String, e.g. `admin#{username}`) | **SK:** `sk` (ISO timestamp)  
**TTL attribute:** `expires_at` (90-day retention)

Records all admin console actions: config changes, key rotations, SAML app CRUD, user management, login/logout events.

---

## 8. Secrets Manager Schema

### 8.1 App Secret (`EntraVerifiedID/{stage}/app`)

JSON blob containing all application credentials:

```json
{
  "clientId":        "app-registration-client-id-for-issuerverifier",
  "clientSecret":    "app-registration-client-secret",
  "eamClientId":     "eam-provider-client-id (unused in this deployment)",
  "eamClientSecret": "eam-provider-client-secret (unused in this deployment)",
  "callbackSecret":  "random-32+-byte-urlsafe-base64-string",
  "eamSigningKey":   "-----BEGIN RSA PRIVATE KEY-----\n...\n-----END RSA PRIVATE KEY-----\n",
  "eamKid":          "base64url-sha1-thumbprint-of-signing-cert"
}
```

> The `eamSigningKey` is an RSA-2048 private key in PEM format. It is used by the SAML IdP to sign assertions. Despite the `eam` prefix (from the legacy EAM flow), it is now exclusively the SAML signing key.

All values initialise to `"PENDING_SETUP"` at CDK deploy time. The admin onboarding wizard populates them.

### 8.2 Bootstrap Admin Secret (`EntraVerifiedID/{stage}/bootstrap-admin`)

```json
{
  "username": "admin",
  "password": "<32-char-auto-generated>"
}
```

Generated by CDK at deploy time. Used once to log in to the admin console to run the setup wizard. The wizard marks this secret as consumed (or it can be deleted manually after setup).

### 8.3 JWT Signing Secret (`EntraVerifiedID/{stage}/jwt-signing-key`)

```json
{
  "algorithm": "HS256",
  "key": "<64-char-auto-generated>"
}
```

Used to sign admin session JWTs (HS256). Generated by CDK at deploy time.

---

## 9. Configuration Management

### Config Load Pattern

All Lambda functions use an identical caching pattern for both secrets and config:

```
Cold start / cache miss
  → Try Lambda Extensions sidecar (localhost:2773, 2s timeout)
  → On failure, fall back to direct AWS SDK call
  → Store in module-level dict with timestamp
  → Return value

Warm invocation (within 5 min)
  → Return cached dict without any AWS API call
```

This means at most one Secrets Manager or DynamoDB call per 5 minutes per Lambda sandbox, regardless of invocation rate.

### The `PENDING_SETUP` Sentinel

Any config value or secret value equal to `"PENDING_SETUP"` causes `_require_config()` / `_require_secret()` to raise `RuntimeError`. This propagates to a clean HTTP 500 response rather than a cryptic auth error, making it immediately obvious that the setup wizard has not been completed.

### Admin Wizard Config Flow

```
Admin console → FastAPI backend → DynamoDB SystemConfigTable  (non-secret config)
                               → Secrets Manager AppSecret     (secrets)
```

The wizard collects all required values in a single guided flow and validates them before writing. Config changes take effect within 5 minutes (next TTL expiry on all Lambda sandboxes).

---

## 10. API Gateway Routes

**API Name:** `EntraVerifiedID-{stage}`  
**Type:** HTTP API (not REST API)  
**Stage:** `$default` (auto-deploy enabled)  
**Throttle:** 100 requests/second sustained, 200 burst  
**Payload format:** Version 2.0

| Method | Path | Lambda | Auth |
|--------|------|--------|------|
| `POST` | `/api/login/start` | `LoginStart` | None (public) |
| `POST` | `/api/login/callback` | `LoginCallback` | `x-api-key` header |
| `GET` | `/api/login/status/{requestId}` | `LoginStatus` | None (public) |
| `POST` | `/api/issue/start` | `IssueStart` | None (public) |
| `POST` | `/api/issue/callback` | `IssueCallback` | `x-api-key` header |
| `GET` | `/api/saml/sso` | `SamlIdp` | None (SP redirect) |
| `POST` | `/api/saml/sso` | `SamlIdp` | None (SP redirect) |
| `GET` | `/api/saml/metadata` | `SamlIdp` | None (public) |
| `GET` | `/api/saml/initiate` | `SamlIdp` | None (internal) |
| `GET` | `/api/saml/complete` | `SamlIdp` | None (internal, session-validated) |
| `GET` | `/api/saml/apps` | `SamlIdp` | None (public) |

CORS is configured at the API level with `allowOrigins: ["https://{publicDomain}"]` when a custom domain is set. All routes accept `OPTIONS` pre-flight via the CORS preflight configuration (not a Lambda route).

---

## 11. Frontend — React SPA on ECS Fargate

### Technology Stack

| Component | Technology |
|-----------|-----------|
| Framework | React 18 + TypeScript |
| UI library | MUI v5 (Material Design) |
| Build tool | Vite |
| Web server | Nginx |
| Container base | `nginx:alpine` |
| Build base | `node:20-alpine` (multi-stage) |

### Container Architecture

The frontend Docker image is built in two stages:

1. **Build stage** — Vite compiles the React SPA to static assets (`/dist`)
2. **Runtime stage** — Nginx serves the static assets and proxies `/api/*`

**Nginx proxy configuration:**

```nginx
location /api/ {
    proxy_pass $API_GATEWAY_URL/;
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
}
```

> The API Gateway URL is injected as an environment variable at container startup. This means the same Docker image can serve any environment without rebuilding.

### QR Login Flow (browser)

The frontend manages a finite state machine:

```
loading → qr → scanning → success → error
                 ↑          │
                 └──timeout──┘
```

1. `loading` — POST `/api/login/start`; receive `{ requestId, qrCode, url }`
2. `qr` — Render QR code image + deep-link; start 10-minute countdown
3. `scanning` — Authenticator scans QR (inferred after first non-pending status or 2s)
4. `success` — Claims received from status endpoint; application session established
5. `error` — Presentation failed, timed out, or network error

Polling: `GET /api/login/status/{requestId}` every 2 seconds, with exponential back-off on network errors.

### Deep-Link Support

The `url` field in the `login/start` response is an `ms-authenticator://` deep-link. On mobile browsers, a button labelled "Open in Authenticator" triggers this link. On desktop, only the QR code is useful.

---

## 12. Admin Console

### Architecture

```
Browser (internal network) → WAF → Internal ALB → ECS Fargate
                                       ├── FastAPI backend (:8000)
                                       └── React admin SPA (served by FastAPI static)
```

The admin console is a single container that serves both the FastAPI API and the compiled React SPA.

### Authentication

1. **Password + Argon2id hashing:**

```python
# Password hashing parameters (OWASP Argon2id recommendation)
argon2.PasswordHasher(
    time_cost=2,           # iterations
    memory_cost=65536,     # 64 MB — GPU/ASIC resistant
    parallelism=2,
    hash_len=32,
    salt_len=16,
    encoding="utf-8",
)
```

2. **Brute force protection:** Lock account for 15 minutes after 5 failed attempts. Stored in `AdminUsersTable.failed_attempts` and `locked_until`.

3. **Session JWT (HS256):** 8-hour expiry. Stored in `HttpOnly` cookie (`Secure` flag when `SECURE_COOKIE=true`). Signed with the key from `jwt-signing-key` secret.

4. **TOTP MFA:** Required after the first password change. `pyotp` generates secrets; the user scans a QR code in their authenticator app. Subsequent logins require a valid TOTP code alongside the password.

### Admin Capabilities

| Feature | Description |
|---------|-------------|
| Setup wizard | Collect Entra credentials, DID, domains; generate signing keys |
| SAML app management | Create/edit/disable SAML-federated apps |
| Key rotation | Generate new RSA-2048 signing key; update JWKS, DID, OIDC docs |
| Session viewer | Live view of active DynamoDB state records |
| Audit log | Immutable trail of all admin actions (90-day retention) |
| System config | Edit any `SystemConfigTable` value |
| User management | Create/reset admin accounts |

---

## 13. SAML 2.0 IdP

### Overview

The SAML IdP allows SAML-federated applications (Amazon WorkSpaces, Kiro) to use Verified ID QR login instead of Entra password authentication. The IdP is stateless aside from DynamoDB session records.

### SAML Binding Support

| Binding | Supported | Notes |
|---------|-----------|-------|
| HTTP-Redirect (AuthnRequest) | Yes | `GET /api/saml/sso` |
| HTTP-POST (AuthnRequest) | Yes | `POST /api/saml/sso` |
| HTTP-POST (Response) | Yes | Auto-submitting form |
| HTTP-Artifact | No | Not needed for current SPs |

### Assertion Structure

The signed SAML assertion includes:

```xml
<saml:Assertion xmlns:saml="urn:oasis:names:tc:SAML:2.0:assertion" ...>
  <saml:Issuer>https://vid.example.com/saml</saml:Issuer>
  <ds:Signature>...</ds:Signature>
  <saml:Subject>
    <saml:NameID Format="urn:oasis:names:tc:SAML:1.1:nameid-format:emailAddress">
      john@example.com
    </saml:NameID>
  </saml:Subject>
  <saml:Conditions NotBefore="..." NotOnOrAfter="...">
    <saml:AudienceRestriction>
      <saml:Audience>urn:amazon:webservices</saml:Audience>
    </saml:AudienceRestriction>
  </saml:Conditions>
  <saml:AttributeStatement>
    <!-- AWS-specific: role ARN + provider ARN -->
    <saml:Attribute Name="https://aws.amazon.com/SAML/Attributes/Role">
      <saml:AttributeValue>arn:aws:iam::…:role/…,arn:aws:iam::…:saml-provider/…</saml:AttributeValue>
    </saml:Attribute>
    <saml:Attribute Name="https://aws.amazon.com/SAML/Attributes/RoleSessionName">
      <saml:AttributeValue>john@example.com</saml:AttributeValue>
    </saml:Attribute>
    <saml:Attribute Name="https://aws.amazon.com/SAML/Attributes/SessionDuration">
      <saml:AttributeValue>43200</saml:AttributeValue>
    </saml:Attribute>
    <!-- VC claims passed through -->
    <saml:Attribute Name="displayName"><saml:AttributeValue>John Doe</saml:AttributeValue></saml:Attribute>
    <saml:Attribute Name="mail"><saml:AttributeValue>john@example.com</saml:AttributeValue></saml:Attribute>
  </saml:AttributeStatement>
</saml:Assertion>
```

### IdP Metadata

Available at `GET /api/saml/metadata`. Returns XML including:
- Entity ID
- SSO endpoint URL (both Redirect and POST bindings)
- Signing certificate (X.509 DER, base64-encoded)

Service providers must import this metadata and configure trust before users can authenticate.

---

## 14. External Service Integrations

### 14.1 Microsoft Entra Verified ID Request Service

**Base URL:** `https://verifiedid.did.msidentity.com/v1.0/verifiableCredentials/`

**Authentication:** OAuth2 client credentials flow targeting the Microsoft-published service app:
```
Scope: 3db474b9-6a0c-4840-96ac-1fceb342124f/.default
Token endpoint: https://login.microsoftonline.com/{tenantId}/oauth2/v2.0/token
```

**`createPresentationRequest` — Login/SAML:**

```
POST https://verifiedid.did.msidentity.com/v1.0/verifiableCredentials/createPresentationRequest
Authorization: Bearer {access_token}
Content-Type: application/json

→ Response: { requestId, qrCode (data:image/png;base64,…), url (ms-authenticator://…) }
```

**`createIssuanceRequest` — Credential issuance:**

```
POST https://verifiedid.did.msidentity.com/v1.0/verifiableCredentials/createIssuanceRequest
Authorization: Bearer {access_token}
Content-Type: application/json

→ Response: same shape as presentation request
```

**Webhook callbacks (inbound to our Lambda):**

Entra sends `POST {callback.url}` with `x-api-key: {callbackSecret}` for each status transition:

| `requestStatus` | Trigger | Payload includes |
|-----------------|---------|-----------------|
| `request_retrieved` | QR code scanned | `state` |
| `presentation_verified` | Credential verified | `state`, `subject`, `verifiedCredentialsData[].claims` |
| `presentation_error` | Verification failed | `state`, `error.code`, `error.message` |
| `issuance_successful` | Credential added to wallet | `state` |
| `issuance_error` | Issuance failed | `state`, `error` |

**VerifiedEmployee credential claims:**

The standard set of claims available in a `VerifiedEmployee` VC:

| Claim | Example |
|-------|---------|
| `displayName` | `John Doe` |
| `givenName` | `John` |
| `surname` | `Doe` |
| `mail` | `john@example.com` |
| `userPrincipalName` | `john@contoso.onmicrosoft.com` |
| `jobTitle` | `Software Engineer` |
| `department` | `Engineering` |
| `employeeId` | `E12345` |

### 14.2 Microsoft Graph API (SAML group checks)

**Endpoint:** `POST https://graph.microsoft.com/v1.0/users/{email}/checkMemberObjects`

Used by `saml_idp` when a SAML app has `allowedGroupIds` configured. The Lambda checks whether the authenticated user is a member of any of the allowed groups before issuing an assertion.

**Token:** OAuth2 client credentials, `scope: https://graph.microsoft.com/.default`

**Required app permissions:** `GroupMember.Read.All` (application permission on the app registration)

```python
body = {"ids": allowed_group_ids}          # list of group object IDs
# Response: ["group-id-1", "group-id-3"]  # subset the user belongs to
if not intersection(response, allowed_group_ids):
    return 403 SAML error response
```

### 14.3 Microsoft OAuth2 Token Endpoint

Called by all Lambdas that need to authenticate to Microsoft APIs:

```
POST https://login.microsoftonline.com/{tenantId}/oauth2/v2.0/token
Content-Type: application/x-www-form-urlencoded

grant_type=client_credentials
&client_id={clientId}
&client_secret={clientSecret}
&scope={target_scope}
```

Tokens are not cached between invocations (access tokens are short-lived but vary by scope; caching would add complexity for minimal latency benefit at current call rates).

---

## 15. Security Design

### Threat Model Summary

| Threat | Mitigation |
|--------|-----------|
| Webhook spoofing | Constant-time `x-api-key` validation on all Entra callbacks |
| Replay attacks | 10-minute DynamoDB TTL; `success → claimed` atomic transition |
| Double-spend (auth codes) | `ConditionExpression` guards on all status transitions |
| SAML assertion injection | ACS URL read from DynamoDB, never from the AuthnRequest |
| SAML open redirect | Same — ACS URL is not caller-controlled |
| Admin brute force | Argon2id hashing; 5-attempt lockout (15 min) |
| Admin credential theft | TOTP MFA required; HttpOnly JWT cookie |
| Admin network exposure | Internal ALB only; WAF IP allowlist (internal network CIDR) |
| Private key exposure | RSA key in Secrets Manager only; never logged; cached in Lambda memory |
| Timing attacks | Constant-time comparison for all secret validation |
| DID spoofing | `validateLinkedDomain: true` in all presentation requests |
| Revoked credentials | `allowRevoked: false` in all presentation requests |

### Constant-Time Comparison

All webhook authentication uses a hand-rolled constant-time comparison instead of `==`:

```python
result = 0
for a, b in zip(received.encode(), expected.encode()):
    result |= a ^ b
return result == 0
```

A length check (`len(received) != len(expected)`) returns `False` before the loop to avoid leaking secret length via timing (the loop time would otherwise correlate with the length of the matching prefix).

### Argon2id Password Hashing

Admin passwords are hashed with Argon2id — the winner of the 2015 Password Hashing Competition and the OWASP-recommended algorithm:

- **64 MB memory cost** — requires 64 MB of RAM per hash attempt, making large-scale GPU/ASIC cracking economically infeasible
- **2 iterations, 2 parallel lanes** — balanced against Lambda 512 MB memory limit
- **Random 16-byte salt** — unique per password, eliminates rainbow table attacks

### RSA Signing Key Management

The SAML/JWT signing key lifecycle:

1. Generated by the admin wizard using `cryptography.hazmat.primitives.asymmetric.rsa`
2. Stored in Secrets Manager (`eamSigningKey` field)
3. Public key published as JWKS at `/.well-known/jwks.json` (S3 via admin)
4. `kid` (key ID = base64url-encoded SHA-1 thumbprint of the DER cert) stored in `SystemConfigTable`
5. Lambda caches the key PEM in module-level memory for the container lifetime (never re-fetched unless the Lambda sandbox is recycled)
6. Key rotation: admin console generates new key, updates Secrets Manager and JWKS simultaneously; old key is removed from JWKS only after confirming all SPs have fetched the new metadata

---

## 16. Prerequisites

### AWS Account Requirements

- AWS account `{aws-account-id}` with appropriate IAM permissions
- Two pre-existing VPCs (see [Section 5](#5-network-topology)):
  - Frontend VPC: has Internet Gateway attached (required for CloudFront VPC Origin)
  - Admin VPC: has outbound egress for ECR (Cloud WAN or NAT Gateway)
- Subnets in ≥2 AZs in each VPC
- Internal network CIDR for admin console access (office via Direct Connect, site-to-site VPN, or client VPN)

### DNS and TLS

- Custom domain (e.g. `vid.example.com`) — optional for test deployments
- Route 53 hosted zone — optional (DNS records can be added manually if zone is in another account)
- ACM certificate in `us-east-1` for CloudFront custom domain
- ACM certificate in the deployment region for API Gateway custom domain

> **Current state:** Both ALBs are HTTP-only (no ACM cert in {aws-region} yet). `SECURE_COOKIE=false` is set on the admin. CloudFront handles TLS termination. Route 53 is in a separate networking account — DNS records are added manually.

### Microsoft Entra Requirements

Before running the setup wizard, obtain:

| Item | Where to find it |
|------|-----------------|
| Azure AD tenant ID | Entra ID → Overview → Tenant ID |
| IssuerVerifier app registration | App registrations → create new or use existing; needs VID API permissions |
| App client ID | App registration → Overview |
| App client secret | App registration → Certificates & secrets |
| DID authority | Entra Verified ID → Overview → DID |
| Accepted issuer DID | Same location |
| VerifiedEmployee manifest URL | Entra Verified ID → Credentials → VerifiedEmployee |

For group-based SAML access control, the app registration also needs `GroupMember.Read.All` application permission (Graph API).

### Local Tooling

| Tool | Version | Purpose |
|------|---------|---------|
| Node.js | ≥18 | CDK TypeScript compilation |
| AWS CDK | v2.x | Infrastructure deployment |
| Docker | any | Lambda layer + ECS image builds |
| AWS CLI | v2 | Authentication, profile management |
| Python | ≥3.12 | Local Lambda testing (optional) |

```bash
npm install -g aws-cdk
```

---

## 17. Deployment Process

### First-Time Deployment

```bash
# 1. Authenticate
aws sso login --profile your-profile

# 2. Navigate to the project directory
cd entra-verified-id

# 3. Install CDK dependencies
npm install

# 4. Bootstrap CDK (one-time per account/region)
CDK_DEFAULT_ACCOUNT={aws-account-id} CDK_DEFAULT_REGION={aws-region} \
  npx cdk bootstrap aws://{aws-account-id}/{aws-region} --profile your-profile

# 5. Run interactive deploy script
./deploy.sh
```

The `deploy.sh` script prompts for all required context values and saves them to `.deploy.env` (gitignored):

```
AWS_PROFILE=your-profile
CDK_DEFAULT_ACCOUNT={aws-account-id}
CDK_DEFAULT_REGION={aws-region}
FRONTEND_VPC_ID={frontend-vpc-id}
FRONTEND_SUBNET_IDS=subnet-xxx,subnet-yyy
ADMIN_VPC_ID={admin-vpc-id}
ADMIN_SUBNET_IDS=subnet-aaa,subnet-bbb
INTERNAL_NETWORK_CIDR={your-internal-cidr}
PUBLIC_DOMAIN=vid.example.com
HOSTED_ZONE_ID=Z...
CF_CERT_ARN=arn:aws:acm:us-east-1:...
REGIONAL_CERT_ARN=arn:aws:acm:{aws-region}:...
CF_PREFIX_LIST_ID={cloudfront-vpc-origin-prefix-list-id}
```

### Stack Deployment Order

CDK resolves dependencies automatically, but for manual deploys:

```bash
# Deploy all stacks (recommended for first deploy)
npx cdk deploy --all --require-approval never

# Or one at a time in order:
npx cdk deploy EntraVid-Data-{stage}
npx cdk deploy EntraVid-Layers-{stage}
npx cdk deploy EntraVid-MainApp-{stage}
npx cdk deploy EntraVid-PublicFrontend-{stage}
npx cdk deploy EntraVid-Admin-{stage}
```

### Post-Deploy: Onboarding Wizard

1. Connect to the internal network (office via Direct Connect, site-to-site VPN, or client VPN)
2. Retrieve bootstrap credentials: `aws secretsmanager get-secret-value --secret-id EntraVerifiedID/{stage}/bootstrap-admin`
3. Navigate to the admin console URL
4. Log in with bootstrap credentials
5. Complete the onboarding wizard:
   - Enter Azure AD tenant ID
   - Enter IssuerVerifier app client ID and secret
   - Enter DID authority and accepted issuer
   - Enter VerifiedEmployee manifest URL
   - Enter domain names
   - Generate RSA signing key (wizard creates key, writes to Secrets Manager + JWKS)
6. Configure the callback URL in the Entra Verified ID admin portal: `https://api.{publicDomain}/api/login/callback`
7. Test a login at `https://{publicDomain}/login`

### Updating Lambda Code

After changing Lambda function code:

```bash
npx cdk deploy EntraVid-MainApp-{stage} --require-approval never --profile your-profile
```

CDK automatically builds a new deployment package (using `aws-lambda-python-alpha`'s Docker-based bundler) and updates the function.

### Updating Frontend or Admin

```bash
# Force a new ECS deployment after CDK deploys the new image
npx cdk deploy EntraVid-PublicFrontend-{stage} --require-approval never
npx cdk deploy EntraVid-Admin-{stage} --require-approval never
```

CDK builds new Docker images, pushes to ECR, and triggers a rolling ECS deployment (no downtime with 2 desired tasks).

### Teardown

```bash
./destroy.sh
# or:
npx cdk destroy --all
```

> DynamoDB tables and Secrets Manager secrets use `RETAIN` removal policy. They are **not** deleted by `cdk destroy` and must be cleaned up manually if required.

---

## 18. Operational Reference

### Environment Variables (Lambda)

| Variable | Set by | Example |
|----------|--------|---------|
| `STATE_TABLE` | CDK | `EntraVerifiedID-{stage}` |
| `APP_TABLE` | CDK | `VerifiedIDSamlApps-{stage}` |
| `SYSTEM_CONFIG_TABLE` | CDK | `EntraVerifiedIDSystemConfig-{stage}` |
| `SECRET_NAME` | CDK | `EntraVerifiedID/{stage}/app` |
| `HOSTING_BUCKET` | CDK | `entra-vid-hosting-{aws-account-id}-{stage}` |
| `STAGE` | CDK | `{stage}` |
| `LOG_LEVEL` | CDK | `INFO` |
| `POWERTOOLS_SERVICE_NAME` | CDK | `EntraVerifiedID-{stage}` |
| `AWS_REGION` | Lambda runtime | `{aws-region}` |
| `AWS_SESSION_TOKEN` | Lambda runtime | (used by Secrets Manager sidecar) |

### CloudWatch Log Groups

| Log group | Lambda / Service |
|-----------|-----------------|
| `/aws/lambda/EntraVerifiedID-LoginStart-{stage}` | login_start |
| `/aws/lambda/EntraVerifiedID-LoginCallback-{stage}` | login_callback |
| `/aws/lambda/EntraVerifiedID-LoginStatus-{stage}` | login_status |
| `/aws/lambda/EntraVerifiedID-IssueStart-{stage}` | issue_start |
| `/aws/lambda/EntraVerifiedID-IssueCallback-{stage}` | issue_callback |
| `/aws/lambda/EntraVerifiedID-SamlIdp-{stage}` | saml_idp |
| `/ecs/entra-vid-frontend-{stage}` | Frontend Fargate |
| `/ecs/entra-vid-admin-{stage}` | Admin Fargate |

### Key Operational Queries

**Find a failed login by requestId:**
```bash
aws dynamodb get-item \
  --table-name EntraVerifiedID-{stage} \
  --key '{"requestId": {"S": "550e8400-e29b-41d4-a716-446655440000"}}'
```

**Invalidate CloudFront cache after JWKS update:**
```bash
aws cloudfront create-invalidation \
  --distribution-id {cloudfront-distribution-id} \
  --paths "/.well-known/*"
```

**Force a new ECS deployment (pick up config change):**
```bash
aws ecs update-service \
  --cluster EntraVid-Frontend-{stage} \
  --service entra-vid-frontend \
  --force-new-deployment
```

**Rotate the signing key via CLI (emergency only — prefer admin console):**
```bash
# The admin console key rotation wizard is the safe path.
# Manual rotation requires updating Secrets Manager + JWKS + DID doc atomically.
```

### Cost Estimate

**Typical enterprise (1 000 authentications/day):**

| Service | Monthly cost |
|---------|-------------|
| Lambda (6 functions) | ~$0.10 |
| API Gateway HTTP API | ~$0.25 |
| DynamoDB (on-demand) | ~$0.50 |
| Secrets Manager (3 secrets) | ~$0.45 |
| ECS Fargate (2 services × 2 tasks) | ~$60–100 |
| ALB (2) | ~$35 |
| CloudFront | ~$0.05 |
| WAF | ~$5 |
| CloudWatch Logs | ~$0.15 |
| **Total** | **~$100–145/month** |

Lambda costs are negligible at this scale. Fargate and ALB dominate the bill.

### Troubleshooting Quick Reference

| Symptom | Likely cause | Investigation |
|---------|-------------|---------------|
| `"Service configuration error"` (500) | Setup wizard not completed | Check `SystemConfigTable` for `PENDING_SETUP` values |
| QR code displays but verification never completes | Callback URL misconfigured | Check Entra portal callback URL; check `login_callback` CloudWatch logs |
| `"Request not found or expired"` (404 on status) | DynamoDB TTL expired (>10 min) or wrong requestId | Normal if user waited >10 min; check for clock skew |
| SAML assertion rejected by SP | Signing cert mismatch | Verify SP has latest IdP metadata; check `kid` in SystemConfig matches JWKS |
| Admin console unreachable | Not on internal network, or WAF IP allowlist change | Confirm internal network connectivity (Direct Connect, site-to-site VPN, or client VPN); check WAF rule IP set |
| Lambda cold start >5s | Layer not warming; Secrets Manager latency | Check Lambda Extensions sidecar logs; consider provisioned concurrency |

#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import { DataStack } from '../lib/data-stack';
import { LayersStack } from '../lib/layers-stack';
import { MainAppStack } from '../lib/main-app-stack';
import { PublicFrontendStack } from '../lib/public-frontend-stack';
import { AdminStack } from '../lib/admin-stack';

const app = new cdk.App();

function ctx(key: string): string | undefined {
  return app.node.tryGetContext(key) as string | undefined;
}
function requireContext(key: string): string {
  const val = ctx(key);
  if (!val) throw new Error(`Missing required CDK context: "${key}". Run ./deploy.sh to configure.`);
  return val;
}

const stage = ctx('stage') ?? 'v2';

// ── Networking — all subnets are pre-existing, operator-managed ──────────────
// The CDK never creates VPCs, subnets, route tables, NAT gateways, or VPC
// endpoints. Those are the operator's responsibility.
//
// frontendVpcId + frontendSubnetIds — frontend internal ALB + Fargate.
//   The VPC must have an internet gateway attached (CloudFront VPC Origin requirement).
//   Subnets should be private with NAT/Cloud WAN egress for ECR pulls.
//   Set assignPublicIp: false when subnets have NAT egress (recommended).
//
// adminVpcId + adminSubnetIds — admin internal ALB + Fargate.
//   Defaults to frontendVpcId/frontendSubnetIds when not set separately.
//   Override when admin and frontend are in different VPCs.

const frontendVpcId     = requireContext('frontendVpcId');
const frontendSubnetIds = requireContext('frontendSubnetIds').split(',').map(s => s.trim());
const adminVpcId        = ctx('adminVpcId') ?? frontendVpcId;
const adminSubnetIds    = (ctx('adminSubnetIds') ?? ctx('frontendSubnetIds') ?? '').split(',').map(s => s.trim());

// Optional: CloudFront VPC Origins managed prefix list ID.
// When set, the frontend ALB SG allows only CloudFront origin IPs.
// When omitted, falls back to anyIpv4().
const cloudfrontPrefixListId = ctx('cloudfrontPrefixListId');

const vpnCidr = ctx('vpnCidr') ?? '0.0.0.0/0';

// ── Domains + certs — all optional; omit for a no-custom-domain test deploy ──
const publicDomain    = ctx('publicDomain');
const adminDomain     = ctx('adminDomain');
const hostedZoneId    = ctx('hostedZoneId');
const cfCertArn           = ctx('cfCertArn');
const regionalCertArn     = ctx('regionalCertArn');
const adminCertArn        = ctx('adminCertArn') ?? regionalCertArn;
const adminAssignPublicIp = ctx('adminAssignPublicIp') === 'true';

const env: cdk.Environment = {
  account: process.env.CDK_DEFAULT_ACCOUNT,
  region:  process.env.CDK_DEFAULT_REGION,
};

const dataStack = new DataStack(app, `EntraVid-Data-${stage}`, { env, stage });

const layersStack = new LayersStack(app, `EntraVid-Layers-${stage}`, { env, stage });

const mainAppStack = new MainAppStack(app, `EntraVid-MainApp-${stage}`, {
  env,
  stage,
  tables:         dataStack.tables,
  appSecret:      dataStack.appSecret,
  hostingBucket:  dataStack.hostingBucket,
  cryptoLayer:    layersStack.cryptoLayer,
  publicDomain,
  hostedZoneId,
  regionalCertArn,
});
mainAppStack.addDependency(dataStack);
mainAppStack.addDependency(layersStack);

const publicFrontendStack = new PublicFrontendStack(app, `EntraVid-PublicFrontend-${stage}`, {
  env,
  stage,
  vpcId:                  frontendVpcId,
  subnetIds:              frontendSubnetIds,
  apiUrl:                 mainAppStack.apiUrl,
  hostingBucket:          dataStack.hostingBucket,
  publicDomain,
  hostedZoneId,
  cfCertArn,
  cloudfrontPrefixListId,
  // assignPublicIp defaults true — set false when private subnets with NAT are available
});
publicFrontendStack.addDependency(mainAppStack);

const adminStack = new AdminStack(app, `EntraVid-Admin-${stage}`, {
  env,
  stage,
  adminVpcId,
  adminSubnetIds,
  tables:           dataStack.tables,
  appSecret:        dataStack.appSecret,
  bootstrapSecret:  dataStack.bootstrapAdminSecret,
  jwtSecret:        dataStack.jwtSigningSecret,
  hostingBucket:    dataStack.hostingBucket,
  wellKnownBucket:  publicFrontendStack.wellKnownBucket,
  adminDomain,
  hostedZoneId,
  regionalCertArn: adminCertArn,
  vpnCidr,
  assignPublicIp: adminAssignPublicIp,
});
adminStack.addDependency(dataStack);
adminStack.addDependency(publicFrontendStack);

cdk.Tags.of(app).add('Project', 'EntraVerifiedID');
cdk.Tags.of(app).add('Stage', stage);
cdk.Tags.of(app).add('ManagedBy', 'CDK');

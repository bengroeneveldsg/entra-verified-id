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
// A single private VPC (adminVpcId + adminSubnetIds) is shared by both the
// admin console and the public frontend. Both ALBs are internal. Fargate tasks
// have no public IP. Public subnets and an internet gateway are not required.
//
// Subnets must have outbound internet access (NAT gateway or Cloud WAN) for
// ECR image pulls and AWS API calls.

const adminVpcId     = requireContext('adminVpcId');
const adminSubnetIds = requireContext('adminSubnetIds').split(',').map(s => s.trim());

// Optional: CloudFront VPC Origins managed prefix list ID.
// When set, the frontend ALB SG allows only CloudFront origin IPs.
// When omitted, falls back to anyIpv4() — safe since the ALB is internal
// in a private VPC with no internet route.
const cloudfrontPrefixListId = ctx('cloudfrontPrefixListId');

const vpnCidr = ctx('vpnCidr') ?? '0.0.0.0/0';

// ── Domains + certs — all optional; omit for a no-custom-domain test deploy ──
const publicDomain    = ctx('publicDomain');
const adminDomain     = ctx('adminDomain');
const hostedZoneId    = ctx('hostedZoneId');
const cfCertArn       = ctx('cfCertArn');
const regionalCertArn = ctx('regionalCertArn');

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
  vpcId:                  adminVpcId,
  subnetIds:              adminSubnetIds,
  apiUrl:                 mainAppStack.apiUrl,
  hostingBucket:          dataStack.hostingBucket,
  publicDomain,
  hostedZoneId,
  cfCertArn,
  cloudfrontPrefixListId,
});
publicFrontendStack.addDependency(mainAppStack);

const adminStack = new AdminStack(app, `EntraVid-Admin-${stage}`, {
  env,
  stage,
  adminVpcId,
  adminSubnetIds,
  tables:          dataStack.tables,
  appSecret:       dataStack.appSecret,
  bootstrapSecret: dataStack.bootstrapAdminSecret,
  jwtSecret:       dataStack.jwtSigningSecret,
  hostingBucket:   dataStack.hostingBucket,
  adminDomain,
  hostedZoneId,
  regionalCertArn,
  vpnCidr,
});
adminStack.addDependency(dataStack);

cdk.Tags.of(app).add('Project', 'EntraVerifiedID');
cdk.Tags.of(app).add('Stage', stage);
cdk.Tags.of(app).add('ManagedBy', 'CDK');

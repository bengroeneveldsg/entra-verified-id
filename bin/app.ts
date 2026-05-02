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
// publicVpcId      + publicSubnetIds   — public frontend ALB + Fargate
//                                        (subnets must have internet access for ECR pulls
//                                         and an internet-facing ALB)
// adminVpcId       + adminSubnetIds    — admin ALB + Fargate
//                                        (subnets must have internet access for ECR pulls;
//                                         ALB is internal, WAF restricts to vpnCidr)
//
// If adminVpcId/adminSubnetIds are not set, the admin uses the public VPC/subnets.
// This is the recommended default for test deployments.

const publicVpcId     = requireContext('publicVpcId');
const publicSubnetIds = requireContext('publicSubnetIds').split(',').map(s => s.trim());
const adminVpcId      = ctx('adminVpcId')      ?? publicVpcId;
const adminSubnetIds  = (ctx('adminSubnetIds') ?? ctx('publicSubnetIds') ?? '').split(',').map(s => s.trim());
const vpnCidr         = ctx('vpnCidr') ?? '0.0.0.0/0';

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
  publicVpcId,
  publicSubnetIds,
  apiUrl:        mainAppStack.apiUrl,
  hostingBucket: dataStack.hostingBucket,
  publicDomain,
  hostedZoneId,
  cfCertArn,
  regionalCertArn,
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

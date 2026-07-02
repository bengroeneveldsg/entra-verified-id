import * as cdk from 'aws-cdk-lib';
import * as ecs from 'aws-cdk-lib/aws-ecs';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as elbv2 from 'aws-cdk-lib/aws-elasticloadbalancingv2';
import * as cloudfront from 'aws-cdk-lib/aws-cloudfront';
import * as origins from 'aws-cdk-lib/aws-cloudfront-origins';
import * as acm from 'aws-cdk-lib/aws-certificatemanager';
import * as route53 from 'aws-cdk-lib/aws-route53';
import * as route53targets from 'aws-cdk-lib/aws-route53-targets';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as ecr_assets from 'aws-cdk-lib/aws-ecr-assets';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as path from 'path';
import { Construct } from 'constructs';

interface PublicFrontendStackProps extends cdk.StackProps {
  stage:      string;
  vpcId:      string;
  subnetIds:  string[];
  apiUrl:     string;
  hostingBucket: s3.Bucket;
  // All optional — omit for a no-custom-domain/no-cert test deployment
  publicDomain?:          string;
  hostedZoneId?:          string;
  cfCertArn?:             string;
  // When provided, ALB SG allows only CloudFront VPC Origins prefix list.
  // When omitted, allows anyIpv4() — safe since ALB is internal with no internet route.
  cloudfrontPrefixListId?: string;
  // Set false when subnetIds are private subnets with NAT/Cloud WAN egress for ECR pulls.
  // Set true (default) when subnetIds are public subnets that require a public IP for ECR.
  assignPublicIp?: boolean;
}

export class PublicFrontendStack extends cdk.Stack {
  public readonly distributionDomain: string;
  public readonly wellKnownBucket:    s3.Bucket;

  constructor(scope: Construct, id: string, props: PublicFrontendStackProps) {
    super(scope, id, {
      ...props,
      description: 'Entra Verified ID — Public frontend: React SPA on ECS Fargate behind CloudFront VPC Origin and internal ALB (private subnets)',
    });
    const {
      stage, vpcId, subnetIds,
      apiUrl, hostingBucket, publicDomain, hostedZoneId,
      cfCertArn, cloudfrontPrefixListId, assignPublicIp = true,
    } = props;

    // ── Well-known bucket — private S3 bucket in this stack for .well-known/* ──
    // OAC and bucket live in the same stack so there is no cyclic cross-stack
    // dependency. The admin writes DID/JWKS/OIDC docs to both this bucket (served
    // via CloudFront OAC) and the hosting bucket (read directly by Lambda via IAM).
    this.wellKnownBucket = new s3.Bucket(this, 'WellKnownBucket', {
      bucketName:        `entra-vid-well-known-${this.account}-${stage}`,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      encryption:        s3.BucketEncryption.S3_MANAGED,
      enforceSSL:        true,
      removalPolicy:     cdk.RemovalPolicy.RETAIN,
    });

    // hasCfDomain: CloudFront gets a custom domain + cert (us-east-1 cert sufficient)
    const hasCfDomain = !!(publicDomain && cfCertArn);
    // hasDns: automatic Route53 record (skip when zone is in another account)
    const hasDns      = !!(hostedZoneId && publicDomain);

    // ── VPC lookup ───────────────────────────────────────────────────────────
    const vpc = ec2.Vpc.fromLookup(this, 'Vpc', { vpcId });
    const subnets = subnetIds.map((id, i) =>
      ec2.Subnet.fromSubnetId(this, `Sub${i}`, id),
    );

    // ── Security groups ──────────────────────────────────────────────────────

    const albSg = new ec2.SecurityGroup(this, 'AlbSg', {
      vpc,
      description: 'Public frontend internal ALB - allow CloudFront VPC Origins',
    });
    // Allow port 80 from CloudFront VPC Origins prefix list when provided, else anyIpv4()
    // (safe fallback: ALB is internal in a private VPC with no internet route)
    const albIngressPeer = cloudfrontPrefixListId
      ? ec2.Peer.prefixList(cloudfrontPrefixListId)
      : ec2.Peer.anyIpv4();
    albSg.addIngressRule(albIngressPeer, ec2.Port.tcp(80), 'HTTP from CloudFront VPC Origins');

    const fargateSg = new ec2.SecurityGroup(this, 'FargateSg', {
      vpc,
      description: 'Public frontend Fargate',
    });
    fargateSg.addIngressRule(albSg, ec2.Port.tcp(80), 'HTTP from ALB');

    // ── ECS cluster ──────────────────────────────────────────────────────────

    const cluster = new ecs.Cluster(this, 'Cluster', {
      vpc,
      clusterName:       `EntraVidFrontend-${stage}`,
      containerInsights: false,
    });

    const taskRole = new iam.Role(this, 'TaskRole', {
      assumedBy: new iam.ServicePrincipal('ecs-tasks.amazonaws.com'),
    });
    hostingBucket.grantRead(taskRole);

    const execRole = new iam.Role(this, 'ExecRole', {
      assumedBy: new iam.ServicePrincipal('ecs-tasks.amazonaws.com'),
      managedPolicies: [
        iam.ManagedPolicy.fromAwsManagedPolicyName('service-role/AmazonECSTaskExecutionRolePolicy'),
      ],
    });

    const taskDef = new ecs.FargateTaskDefinition(this, 'TaskDef', {
      family:          `entra-vid-frontend-${stage}`,
      cpu:             256,
      memoryLimitMiB:  512,
      runtimePlatform: {
        cpuArchitecture:       ecs.CpuArchitecture.X86_64,
        operatingSystemFamily: ecs.OperatingSystemFamily.LINUX,
      },
      taskRole,
      executionRole: execRole,
    });

    const image = new ecr_assets.DockerImageAsset(this, 'FrontendImage', {
      directory:  path.join(__dirname, '..'),
      file:       'frontend/Dockerfile',
      platform:   ecr_assets.Platform.LINUX_AMD64,
      buildArgs:  { PUBLIC_DOMAIN: publicDomain ?? '' },
    });

    const logGroup = new logs.LogGroup(this, 'FrontendLogs', {
      logGroupName:  `/entra-vid/frontend-${stage}`,
      retention:     logs.RetentionDays.ONE_MONTH,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    taskDef.addContainer('frontend', {
      image:        ecs.ContainerImage.fromDockerImageAsset(image),
      portMappings: [{ containerPort: 80 }],
      environment: {
        API_URL: apiUrl,
      },
      logging: ecs.LogDrivers.awsLogs({ streamPrefix: 'frontend', logGroup }),
      healthCheck: {
        command:     ['CMD-SHELL', 'curl -sf http://localhost/health || exit 1'],
        interval:    cdk.Duration.seconds(30),
        timeout:     cdk.Duration.seconds(5),
        retries:     3,
        startPeriod: cdk.Duration.seconds(15),
      },
    });

    // ── Fargate service — private subnets, no public IP ──────────────────────

    const service = new ecs.FargateService(this, 'Service', {
      cluster,
      taskDefinition: taskDef,
      desiredCount:   2,
      vpcSubnets:     { subnets },
      securityGroups: [fargateSg],
      assignPublicIp,
      circuitBreaker:  { rollback: true },
    });

    // ── Internal ALB (private subnets) ───────────────────────────────────────

    const alb = new elbv2.ApplicationLoadBalancer(this, 'Alb', {
      vpc,
      internetFacing:   false,
      vpcSubnets:       { subnets },
      securityGroup:    albSg,
      loadBalancerName: `entra-vid-frontend-${stage}`,
    });

    const targetGroup = new elbv2.ApplicationTargetGroup(this, 'TG', {
      vpc,
      port:     80,
      protocol: elbv2.ApplicationProtocol.HTTP,
      targets:  [service],
      healthCheck: { path: '/health', interval: cdk.Duration.seconds(30) },
      deregistrationDelay: cdk.Duration.seconds(30),
    });

    alb.addListener('HttpListener', {
      port:          80,
      defaultAction: elbv2.ListenerAction.forward([targetGroup]),
    });

    // ── CloudFront distribution ──────────────────────────────────────────────

    // CloudFront VPC Origin → internal ALB (HTTP only; TLS terminates at CloudFront)
    const albOrigin = origins.VpcOrigin.withApplicationLoadBalancer(alb, {
      protocolPolicy: cloudfront.OriginProtocolPolicy.HTTP_ONLY,
      httpPort:       80,
    });

    // OAC origin for /.well-known/* — bucket and distribution are in the same
    // stack so there is no cyclic dependency. CloudFront signs S3 requests with
    // SigV4; the bucket stays fully private (BLOCK_ALL).
    const s3WellKnownOrigin = origins.S3BucketOrigin.withOriginAccessControl(this.wellKnownBucket);

    const distribution = new cloudfront.Distribution(this, 'Distribution', {
      comment:     `EntraVerifiedID ${stage} public frontend`,
      // Custom CloudFront domain requires cfCertArn in us-east-1; omit for *.cloudfront.net default
      ...(hasCfDomain
        ? {
            domainNames: [publicDomain!],
            certificate: acm.Certificate.fromCertificateArn(this, 'CfCert', cfCertArn!),
          }
        : {}),
      minimumProtocolVersion: cloudfront.SecurityPolicyProtocol.TLS_V1_2_2021,
      defaultBehavior: {
        origin:               albOrigin,
        viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
        cachePolicy:          cloudfront.CachePolicy.CACHING_DISABLED,
        originRequestPolicy:  cloudfront.OriginRequestPolicy.ALL_VIEWER_EXCEPT_HOST_HEADER,
        allowedMethods:       cloudfront.AllowedMethods.ALLOW_ALL,
        responseHeadersPolicy: cloudfront.ResponseHeadersPolicy.SECURITY_HEADERS,
      },
      additionalBehaviors: {
        '/assets/*': {
          origin:               albOrigin,
          viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
          cachePolicy:          cloudfront.CachePolicy.CACHING_OPTIMIZED,
          originRequestPolicy:  cloudfront.OriginRequestPolicy.ALL_VIEWER_EXCEPT_HOST_HEADER,
          responseHeadersPolicy: cloudfront.ResponseHeadersPolicy.SECURITY_HEADERS,
        },
        '/api/*': {
          origin:               albOrigin,
          viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
          cachePolicy:          cloudfront.CachePolicy.CACHING_DISABLED,
          originRequestPolicy:  cloudfront.OriginRequestPolicy.ALL_VIEWER_EXCEPT_HOST_HEADER,
          allowedMethods:       cloudfront.AllowedMethods.ALLOW_ALL,
          responseHeadersPolicy: cloudfront.ResponseHeadersPolicy.SECURITY_HEADERS,
        },
        '/.well-known/*': {
          origin:               s3WellKnownOrigin,
          viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
          cachePolicy:          cloudfront.CachePolicy.CACHING_OPTIMIZED,
          responseHeadersPolicy: cloudfront.ResponseHeadersPolicy.SECURITY_HEADERS,
        },
      },
    });

    this.distributionDomain = distribution.distributionDomainName;

    // ── Optional Route 53 record — skipped when zone is in a different account ─
    if (hasDns) {
      const zone = route53.HostedZone.fromHostedZoneAttributes(this, 'Zone', {
        hostedZoneId: hostedZoneId!,
        zoneName:     publicDomain!.split('.').slice(-2).join('.'),
      });
      new route53.ARecord(this, 'FrontendAlias', {
        zone,
        recordName: publicDomain,
        target:     route53.RecordTarget.fromAlias(
          new route53targets.CloudFrontTarget(distribution),
        ),
      });
    }

    // ── Outputs ──────────────────────────────────────────────────────────────

    new cdk.CfnOutput(this, 'CloudFrontUrl',      { value: `https://${distribution.distributionDomainName}` });
    new cdk.CfnOutput(this, 'DistributionId',     { value: distribution.distributionId });
    new cdk.CfnOutput(this, 'DistributionDomain', { value: distribution.distributionDomainName });
    new cdk.CfnOutput(this, 'AlbDns',             { value: alb.loadBalancerDnsName });

    if (hasCfDomain) {
      new cdk.CfnOutput(this, 'PublicUrl',     { value: `https://${publicDomain}` });
      new cdk.CfnOutput(this, 'ManualDnsNote', {
        value: hasDns
          ? 'DNS record created automatically in Route53.'
          : `ACTION REQUIRED: Add CNAME ${publicDomain} → ${distribution.distributionDomainName} in your Route53 account.`,
      });
    }
  }
}

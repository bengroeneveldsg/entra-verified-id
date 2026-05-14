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
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as path from 'path';
import { Construct } from 'constructs';

interface PublicFrontendStackProps extends cdk.StackProps {
  stage:           string;
  publicVpcId:     string;
  publicSubnetIds: string[];
  apiUrl:          string;
  hostingBucket:   s3.Bucket;
  // All optional — omit for a no-custom-domain/no-cert test deployment
  publicDomain?:    string;
  hostedZoneId?:    string;
  cfCertArn?:       string;
  regionalCertArn?: string;
  // When provided, Fargate tasks run here (no public IP needed — egress via NAT/Cloud WAN).
  // When omitted, tasks fall back to publicSubnetIds with assignPublicIp: true.
  frontendPrivateSubnetIds?: string[];
}

export class PublicFrontendStack extends cdk.Stack {
  public readonly distributionDomain: string;

  constructor(scope: Construct, id: string, props: PublicFrontendStackProps) {
    super(scope, id, {
      ...props,
      description: 'Entra Verified ID — Public frontend: React SPA on ECS Fargate behind CloudFront and internet-facing ALB',
    });
    const {
      stage, publicVpcId, publicSubnetIds,
      apiUrl, hostingBucket, publicDomain, hostedZoneId,
      cfCertArn, regionalCertArn, frontendPrivateSubnetIds,
    } = props;

    const hasPrivateSubnets = !!(frontendPrivateSubnetIds && frontendPrivateSubnetIds.length > 0);

    // hasCfDomain: CloudFront gets a custom domain + cert (us-east-1 cert sufficient)
    const hasCfDomain  = !!(publicDomain && cfCertArn);
    // hasAlbTls: ALB also gets HTTPS listener (regional cert required — optional)
    const hasAlbTls    = !!(regionalCertArn);
    // hasDns: automatic Route53 record (skip when zone is in another account)
    const hasDns       = !!(hostedZoneId && publicDomain);

    // ── VPC lookup — public VPC (has internet gateway) ───────────────────────
    const vpc = ec2.Vpc.fromLookup(this, 'PublicVpc', { vpcId: publicVpcId });
    const publicSubnets = publicSubnetIds.map((id, i) =>
      ec2.Subnet.fromSubnetId(this, `PubSub${i}`, id),
    );

    // ── Security groups ──────────────────────────────────────────────────────

    const albSg = new ec2.SecurityGroup(this, 'AlbSg', {
      vpc,
      description: 'Public frontend ALB',
    });
    albSg.addIngressRule(ec2.Peer.anyIpv4(), ec2.Port.tcp(80), 'HTTP');
    if (hasAlbTls) {
      albSg.addIngressRule(ec2.Peer.anyIpv4(), ec2.Port.tcp(443), 'HTTPS from CloudFront');
    }

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
      directory: path.join(__dirname, '..'),
      file:      'frontend/Dockerfile',
      platform:  ecr_assets.Platform.LINUX_AMD64,
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
        API_URL:          apiUrl,
        HOSTING_BUCKET:   hostingBucket.bucketName,
        AWS_REGION:       this.region,
        HOSTING_BUCKET_URL: `https://${hostingBucket.bucketName}.s3.${this.region}.amazonaws.com`,
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

    // ── Fargate service ──────────────────────────────────────────────────────
    // Prefer private subnets (no public IP; egress via NAT/Cloud WAN).
    // Falls back to public subnets with a public IP when no private subnets are configured.
    const fargateSubnets = hasPrivateSubnets
      ? frontendPrivateSubnetIds!.map((id, i) => ec2.Subnet.fromSubnetId(this, `PrivSub${i}`, id))
      : publicSubnets;

    const service = new ecs.FargateService(this, 'Service', {
      cluster,
      taskDefinition: taskDef,
      desiredCount:   2,
      vpcSubnets:     { subnets: fargateSubnets },
      securityGroups: [fargateSg],
      assignPublicIp: !hasPrivateSubnets,
      circuitBreaker:  { rollback: true },
    });

    // ── Internet-facing ALB ──────────────────────────────────────────────────

    const alb = new elbv2.ApplicationLoadBalancer(this, 'Alb', {
      vpc,
      internetFacing:   true,
      vpcSubnets:       { subnets: publicSubnets },
      securityGroup:    albSg,
      loadBalancerName: `entra-vid-public-${stage}`,
    });

    const targetGroup = new elbv2.ApplicationTargetGroup(this, 'TG', {
      vpc,
      port:     80,
      protocol: elbv2.ApplicationProtocol.HTTP,
      targets:  [service],
      healthCheck: { path: '/health', interval: cdk.Duration.seconds(30) },
      deregistrationDelay: cdk.Duration.seconds(30),
    });

    if (hasAlbTls) {
      // HTTPS listener on ALB (regional cert present)
      alb.addListener('HttpsListener', {
        port:         443,
        protocol:     elbv2.ApplicationProtocol.HTTPS,
        certificates: [acm.Certificate.fromCertificateArn(this, 'AlbCert', regionalCertArn!)],
        defaultAction: elbv2.ListenerAction.forward([targetGroup]),
      });
      alb.addListener('HttpRedirect', {
        port:          80,
        defaultAction: elbv2.ListenerAction.redirect({ protocol: 'HTTPS', port: '443', permanent: true }),
      });
    } else {
      // HTTP-only ALB — CloudFront handles user-facing HTTPS, ALB is internal
      alb.addListener('HttpListener', {
        port:          80,
        defaultAction: elbv2.ListenerAction.forward([targetGroup]),
      });
    }

    // ── CloudFront distribution ──────────────────────────────────────────────

    // CloudFront → ALB: use HTTPS if ALB has a cert, else HTTP (fine — AWS backbone)
    const albOrigin = new origins.LoadBalancerV2Origin(alb, {
      protocolPolicy: hasAlbTls
        ? cloudfront.OriginProtocolPolicy.HTTPS_ONLY
        : cloudfront.OriginProtocolPolicy.HTTP_ONLY,
    });

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
          origin:               albOrigin,
          viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
          cachePolicy:          cloudfront.CachePolicy.CACHING_DISABLED,
          originRequestPolicy:  cloudfront.OriginRequestPolicy.ALL_VIEWER_EXCEPT_HOST_HEADER,
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

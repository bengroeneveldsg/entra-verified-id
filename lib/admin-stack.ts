import * as cdk from 'aws-cdk-lib';
import * as ecs from 'aws-cdk-lib/aws-ecs';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as elbv2 from 'aws-cdk-lib/aws-elasticloadbalancingv2';
import * as acm from 'aws-cdk-lib/aws-certificatemanager';
import * as route53 from 'aws-cdk-lib/aws-route53';
import * as route53targets from 'aws-cdk-lib/aws-route53-targets';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import * as ecr_assets from 'aws-cdk-lib/aws-ecr-assets';
import * as wafv2 from 'aws-cdk-lib/aws-wafv2';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as path from 'path';
import { Construct } from 'constructs';
import { StackTables } from './data-stack';

interface AdminStackProps extends cdk.StackProps {
  stage:            string;
  adminVpcId:     string;
  adminSubnetIds: string[];
  tables:           StackTables;
  appSecret:        secretsmanager.Secret;
  bootstrapSecret:  secretsmanager.Secret;
  jwtSecret:        secretsmanager.Secret;
  hostingBucket:    s3.Bucket;
  vpnCidr:          string;
  // Optional — omit for no-custom-domain test deployment
  adminDomain?:     string;
  hostedZoneId?:    string;
  regionalCertArn?: string;
}

export class AdminStack extends cdk.Stack {
  public readonly adminAlbDns: string;

  constructor(scope: Construct, id: string, props: AdminStackProps) {
    super(scope, id, props);
    const {
      stage, adminVpcId, adminSubnetIds,
      tables, appSecret, bootstrapSecret, jwtSecret, hostingBucket,
      adminDomain, hostedZoneId, regionalCertArn, vpnCidr,
    } = props;

    const hasCustomDomain = !!(adminDomain && regionalCertArn && hostedZoneId);

    // ── VPC lookup ───────────────────────────────────────────────────────────

    const vpc = ec2.Vpc.fromLookup(this, 'Vpc', { vpcId: adminVpcId });
    const adminSubnets = adminSubnetIds.map((id, i) =>
      ec2.Subnet.fromSubnetId(this, `PrivSub${i}`, id),
    );

    // ── WAF (VPN CIDR restriction) ───────────────────────────────────────────

    const ipSet = new wafv2.CfnIPSet(this, 'VpnIpSet', {
      name:             `EntraVidAdminVpn-${stage}`,
      scope:            'REGIONAL',
      ipAddressVersion: 'IPV4',
      addresses:        [vpnCidr],
    });

    const waf = new wafv2.CfnWebACL(this, 'AdminWaf', {
      name:          `EntraVidAdmin-${stage}`,
      scope:         'REGIONAL',
      defaultAction: { block: {} },
      visibilityConfig: {
        cloudWatchMetricsEnabled: true,
        metricName:               `EntraVidAdmin-${stage}`,
        sampledRequestsEnabled:   true,
      },
      rules: [{
        name:     'AllowVpnCidr',
        priority: 1,
        action:   { allow: {} },
        statement: { ipSetReferenceStatement: { arn: ipSet.attrArn } },
        visibilityConfig: {
          cloudWatchMetricsEnabled: false,
          metricName:               'AllowVpnCidr',
          sampledRequestsEnabled:   false,
        },
      }],
    });

    // ── Security groups ──────────────────────────────────────────────────────

    const albSg = new ec2.SecurityGroup(this, 'AlbSg', {
      vpc,
      description: 'Admin ALB - VPN CIDR only',
    });
    albSg.addIngressRule(ec2.Peer.ipv4(vpnCidr), ec2.Port.tcp(80),  'HTTP from VPN');
    if (hasCustomDomain) {
      albSg.addIngressRule(ec2.Peer.ipv4(vpnCidr), ec2.Port.tcp(443), 'HTTPS from VPN');
    }

    const fargateSg = new ec2.SecurityGroup(this, 'FargateSg', {
      vpc,
      description: 'Admin Fargate - HTTP from ALB only',
    });
    fargateSg.addIngressRule(albSg, ec2.Port.tcp(8000), 'FastAPI from ALB');

    // ── IAM task role ────────────────────────────────────────────────────────

    const taskRole = new iam.Role(this, 'TaskRole', {
      roleName:  `EntraVidAdmin-Task-${stage}`,
      assumedBy: new iam.ServicePrincipal('ecs-tasks.amazonaws.com'),
    });

    tables.stateTable.grantReadWriteData(taskRole);
    tables.samlAppsTable.grantReadWriteData(taskRole);
    tables.systemConfig.grantReadWriteData(taskRole);
    tables.adminUsers.grantReadWriteData(taskRole);
    tables.auditLog.grantReadWriteData(taskRole);

    appSecret.grantRead(taskRole);
    appSecret.grantWrite(taskRole);
    bootstrapSecret.grantRead(taskRole);
    bootstrapSecret.grantWrite(taskRole);
    jwtSecret.grantRead(taskRole);

    hostingBucket.grantPut(taskRole, '.well-known/*');
    hostingBucket.grantPut(taskRole, 'config.json');
    hostingBucket.grantRead(taskRole);

    taskRole.addToPolicy(new iam.PolicyStatement({
      actions:   ['logs:StartQuery', 'logs:GetQueryResults', 'logs:DescribeLogGroups'],
      resources: ['*'],
    }));
    taskRole.addManagedPolicy(
      iam.ManagedPolicy.fromAwsManagedPolicyName('AWSXRayDaemonWriteAccess'),
    );

    const execRole = new iam.Role(this, 'ExecRole', {
      assumedBy: new iam.ServicePrincipal('ecs-tasks.amazonaws.com'),
      managedPolicies: [
        iam.ManagedPolicy.fromAwsManagedPolicyName('service-role/AmazonECSTaskExecutionRolePolicy'),
      ],
    });

    // ── ECS cluster & task ───────────────────────────────────────────────────

    const cluster = new ecs.Cluster(this, 'Cluster', {
      vpc,
      clusterName:       `EntraVidAdmin-${stage}`,
      containerInsights: false,
    });

    const taskDef = new ecs.FargateTaskDefinition(this, 'TaskDef', {
      family:         `entra-vid-admin-${stage}`,
      cpu:            256,
      memoryLimitMiB: 512,
      runtimePlatform: {
        cpuArchitecture:       ecs.CpuArchitecture.X86_64,
        operatingSystemFamily: ecs.OperatingSystemFamily.LINUX,
      },
      taskRole,
      executionRole: execRole,
    });

    const image = new ecr_assets.DockerImageAsset(this, 'AdminImage', {
      directory: path.join(__dirname, '..'),
      file:      'admin/Dockerfile',
      platform:  ecr_assets.Platform.LINUX_AMD64,
    });

    const logGroup = new logs.LogGroup(this, 'AdminLogs', {
      logGroupName:  `/entra-vid/admin-${stage}`,
      retention:     logs.RetentionDays.ONE_MONTH,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    taskDef.addContainer('admin', {
      image:        ecs.ContainerImage.fromDockerImageAsset(image),
      portMappings: [{ containerPort: 8000 }],
      environment: {
        STATE_TABLE:           tables.stateTable.tableName,
        APP_TABLE:             tables.samlAppsTable.tableName,
        SYSTEM_CONFIG_TABLE:   tables.systemConfig.tableName,
        ADMIN_USERS_TABLE:     tables.adminUsers.tableName,
        AUDIT_LOG_TABLE:       tables.auditLog.tableName,
        HOSTING_BUCKET:        hostingBucket.bucketName,
        APP_SECRET_NAME:       appSecret.secretName,
        JWT_SECRET_NAME:       jwtSecret.secretName,
        BOOTSTRAP_SECRET_NAME: bootstrapSecret.secretName,
        // Use secure=false when no TLS cert on the ALB; set to true in production
        SECURE_COOKIE: hasCustomDomain ? 'true' : 'false',
        AWS_REGION:            this.region,
        ADMIN_DOMAIN:          adminDomain ?? '',
        STAGE:                 stage,
      },
      logging: ecs.LogDrivers.awsLogs({ streamPrefix: 'admin', logGroup }),
      healthCheck: {
        command:     ['CMD-SHELL', 'curl -sf http://localhost:8000/health || exit 1'],
        interval:    cdk.Duration.seconds(30),
        timeout:     cdk.Duration.seconds(5),
        retries:     3,
        startPeriod: cdk.Duration.seconds(15),
      },
    });

    // ── Fargate service ──────────────────────────────────────────────────────

    const service = new ecs.FargateService(this, 'Service', {
      cluster,
      taskDefinition: taskDef,
      desiredCount:   2,
      vpcSubnets:     { subnets: adminSubnets },
      securityGroups: [fargateSg],
      assignPublicIp: false,
      circuitBreaker:  { rollback: true },
    });

    // ── Internal ALB ─────────────────────────────────────────────────────────

    const alb = new elbv2.ApplicationLoadBalancer(this, 'Alb', {
      vpc,
      internetFacing:   false, // internal ALB — only reachable via VPN/private network
      vpcSubnets:       { subnets: adminSubnets },
      securityGroup:    albSg,
      loadBalancerName: `entra-vid-admin-${stage}`,
    });

    new wafv2.CfnWebACLAssociation(this, 'WafAssoc', {
      resourceArn: alb.loadBalancerArn,
      webAclArn:   waf.attrArn,
    });

    const targetGroup = new elbv2.ApplicationTargetGroup(this, 'TG', {
      vpc,
      port:     8000,
      protocol: elbv2.ApplicationProtocol.HTTP,
      targets:  [service],
      healthCheck: { path: '/health', interval: cdk.Duration.seconds(30) },
      deregistrationDelay: cdk.Duration.seconds(30),
    });

    if (hasCustomDomain) {
      alb.addListener('HttpsListener', {
        port:         443,
        protocol:     elbv2.ApplicationProtocol.HTTPS,
        certificates: [acm.Certificate.fromCertificateArn(this, 'Cert', regionalCertArn!)],
        defaultAction: elbv2.ListenerAction.forward([targetGroup]),
      });
      alb.addListener('HttpRedirect', {
        port:          80,
        defaultAction: elbv2.ListenerAction.redirect({ protocol: 'HTTPS', port: '443', permanent: true }),
      });

      const zone = route53.HostedZone.fromHostedZoneAttributes(this, 'Zone', {
        hostedZoneId: hostedZoneId!,
        zoneName:     adminDomain!.split('.').slice(-2).join('.'),
      });
      new route53.ARecord(this, 'AdminAlias', {
        zone,
        recordName: adminDomain,
        target:     route53.RecordTarget.fromAlias(new route53targets.LoadBalancerTarget(alb)),
      });
    } else {
      // Test mode — HTTP only, access via ALB DNS name from VPN
      alb.addListener('HttpListener', {
        port:          80,
        defaultAction: elbv2.ListenerAction.forward([targetGroup]),
      });
    }

    this.adminAlbDns = alb.loadBalancerDnsName;

    // ── Outputs ──────────────────────────────────────────────────────────────

    new cdk.CfnOutput(this, 'AdminAlbDns', { value: alb.loadBalancerDnsName });
    new cdk.CfnOutput(this, 'AdminUrl', {
      value: hasCustomDomain
        ? `https://${adminDomain}`
        : `http://${alb.loadBalancerDnsName} (VPN access only — WAF blocks outside ${vpnCidr})`,
    });
  }
}

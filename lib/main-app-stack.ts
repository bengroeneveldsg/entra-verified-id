import * as cdk from 'aws-cdk-lib';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as python from '@aws-cdk/aws-lambda-python-alpha';
import * as apigwv2 from 'aws-cdk-lib/aws-apigatewayv2';
import * as integrations from 'aws-cdk-lib/aws-apigatewayv2-integrations';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import * as acm from 'aws-cdk-lib/aws-certificatemanager';
import * as route53 from 'aws-cdk-lib/aws-route53';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as path from 'path';
import { Construct } from 'constructs';
import { StackTables } from './data-stack';

interface MainAppStackProps extends cdk.StackProps {
  stage:           string;
  tables:          StackTables;
  appSecret:       secretsmanager.Secret;
  hostingBucket:   s3.Bucket;
  cryptoLayer:     lambda.ILayerVersion;
  // Optional — omit for no-custom-domain test deployment (uses default API GW URL)
  publicDomain?:    string;
  hostedZoneId?:    string;
  regionalCertArn?: string;
}

export class MainAppStack extends cdk.Stack {
  public readonly apiUrl: string;

  constructor(scope: Construct, id: string, props: MainAppStackProps) {
    super(scope, id, {
      ...props,
      description: 'Entra Verified ID — Lambda functions (login, issue, SAML IdP) and API Gateway HTTP API',
    });
    const {
      stage, tables, appSecret, hostingBucket, cryptoLayer,
      publicDomain, hostedZoneId, regionalCertArn,
    } = props;

    // Shared environment for all Lambdas
    const sharedEnv: Record<string, string> = {
      STATE_TABLE:          tables.stateTable.tableName,
      APP_TABLE:            tables.samlAppsTable.tableName,
      SYSTEM_CONFIG_TABLE:  tables.systemConfig.tableName,
      SECRET_NAME:          appSecret.secretName,
      HOSTING_BUCKET:       hostingBucket.bucketName,
      STAGE:                stage,
      LOG_LEVEL:            'INFO',
      POWERTOOLS_SERVICE_NAME: `EntraVerifiedID-${stage}`,
    };

    // Shared IAM role for all Lambdas
    const lambdaRole = new iam.Role(this, 'LambdaRole', {
      roleName:  `EntraVerifiedID-Lambda-${stage}`,
      assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com'),
      managedPolicies: [
        iam.ManagedPolicy.fromAwsManagedPolicyName('service-role/AWSLambdaBasicExecutionRole'),
      ],
    });

    // DynamoDB permissions
    tables.stateTable.grantReadWriteData(lambdaRole);
    tables.samlAppsTable.grantReadData(lambdaRole);
    tables.systemConfig.grantReadData(lambdaRole);

    // Secrets Manager
    appSecret.grantRead(lambdaRole);

    // S3 hosting bucket — SAML IdP reads JWKS cert to sign assertions
    hostingBucket.grantRead(lambdaRole);

    // X-Ray
    lambdaRole.addManagedPolicy(
      iam.ManagedPolicy.fromAwsManagedPolicyName('AWSXRayDaemonWriteAccess'),
    );

    // Helper: create a PythonFunction with consistent defaults
    const fn = (id: string, entry: string, extraEnv?: Record<string, string>, useCrypto = false) => {
      const layers: lambda.ILayerVersion[] = useCrypto ? [cryptoLayer] : [];

      return new python.PythonFunction(this, id, {
        functionName:  `EntraVerifiedID-${id}-${stage}`,
        entry:         path.join(__dirname, '..', 'lambdas', entry),
        index:         'handler.py',
        handler:       'handler',
        runtime:       lambda.Runtime.PYTHON_3_12,
        architecture:  lambda.Architecture.X86_64,
        memorySize:    useCrypto ? 512 : 256,
        timeout:       cdk.Duration.seconds(30),
        role:          lambdaRole,
        tracing:       lambda.Tracing.ACTIVE,
        layers,
        environment:   { ...sharedEnv, ...extraEnv },
      });
    };

    const loginStart    = fn('LoginStart',    'login_start');
    const loginCallback = fn('LoginCallback', 'login_callback');
    const loginStatus   = fn('LoginStatus',   'login_status');
    const issueStart    = fn('IssueStart',    'issue_start');
    const issueCallback = fn('IssueCallback', 'issue_callback');
    const samlIdp       = fn('SamlIdp',       'saml_idp',       {}, true);

    // ── API Gateway HTTP API ─────────────────────────────────────────────────

    const httpApi = new apigwv2.HttpApi(this, 'HttpApi', {
      apiName:     `EntraVerifiedID-${stage}`,
      description: 'Entra Verified ID API',
      createDefaultStage: false,
      corsPreflight: {
        allowOrigins: publicDomain ? [`https://${publicDomain}`] : ['*'],
        allowMethods: [
          apigwv2.CorsHttpMethod.GET,
          apigwv2.CorsHttpMethod.POST,
          apigwv2.CorsHttpMethod.OPTIONS,
        ],
        allowHeaders: ['content-type', 'x-api-key'],
        maxAge:       cdk.Duration.days(1),
      },
    });

    // Create default stage with throttling
    httpApi.addStage('DefaultStage', {
      stageName:  '$default',
      autoDeploy: true,
      throttle: { burstLimit: 200, rateLimit: 100 },
    });

    // Helper: add route
    const route = (
      method: apigwv2.HttpMethod,
      routePath: string,
      handler: lambda.Function,
    ) =>
      httpApi.addRoutes({
        path:        routePath,
        methods:     [method],
        integration: new integrations.HttpLambdaIntegration(
          `${method}${routePath.replace(/[^a-zA-Z0-9]/g, '')}Int`,
          handler,
          { payloadFormatVersion: apigwv2.PayloadFormatVersion.VERSION_2_0 },
        ),
      });

    route(apigwv2.HttpMethod.POST, '/api/login/start',                  loginStart);
    route(apigwv2.HttpMethod.POST, '/api/login/callback',               loginCallback);
    route(apigwv2.HttpMethod.GET,  '/api/login/status/{requestId}',     loginStatus);
    route(apigwv2.HttpMethod.POST, '/api/issue/start',                  issueStart);
    route(apigwv2.HttpMethod.POST, '/api/issue/callback',               issueCallback);
    route(apigwv2.HttpMethod.GET,  '/api/saml/sso',                     samlIdp);
    route(apigwv2.HttpMethod.POST, '/api/saml/sso',                     samlIdp);
    route(apigwv2.HttpMethod.GET,  '/api/saml/metadata',                samlIdp);
    route(apigwv2.HttpMethod.GET,  '/api/saml/initiate',               samlIdp);
    route(apigwv2.HttpMethod.GET,  '/api/saml/complete',                samlIdp);
    route(apigwv2.HttpMethod.GET,  '/api/saml/apps',                    samlIdp);

    // ── API Gateway custom domain (optional) ────────────────────────────────

    if (publicDomain && regionalCertArn && hostedZoneId) {
      const cert = acm.Certificate.fromCertificateArn(this, 'RegionalCert', regionalCertArn);
      const apiDomain = `api.${publicDomain}`;
      const domainName = new apigwv2.DomainName(this, 'ApiDomain', {
        domainName:  apiDomain,
        certificate: cert,
      });
      new apigwv2.ApiMapping(this, 'ApiMapping', { api: httpApi, domainName });

      const hostedZone = route53.HostedZone.fromHostedZoneAttributes(this, 'Zone', {
        hostedZoneId,
        zoneName: publicDomain.split('.').slice(-2).join('.'),
      });
      new route53.CnameRecord(this, 'ApiDnsRecord', {
        zone:       hostedZone,
        recordName: `api.${publicDomain}`,
        domainName: domainName.regionalDomainName,
        ttl:        cdk.Duration.minutes(5),
      });
      this.apiUrl = `https://${apiDomain}`;
    } else {
      // Test mode — use the default API Gateway execute-api URL
      this.apiUrl = httpApi.apiEndpoint;
    }

    // ── Outputs ──────────────────────────────────────────────────────────────

    new cdk.CfnOutput(this, 'ApiUrl',       { value: this.apiUrl });
    new cdk.CfnOutput(this, 'HttpApiId',    { value: httpApi.apiId });
    new cdk.CfnOutput(this, 'LambdaRoleArn', { value: lambdaRole.roleArn });
  }
}

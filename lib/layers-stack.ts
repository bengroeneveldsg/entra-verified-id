import * as cdk from 'aws-cdk-lib';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as path from 'path';
import { Construct } from 'constructs';

interface LayersStackProps extends cdk.StackProps {
  stage: string;
}

export class LayersStack extends cdk.Stack {
  public readonly cryptoLayer: lambda.ILayerVersion;

  constructor(scope: Construct, id: string, props: LayersStackProps) {
    super(scope, id, props);

    // x86_64 layer: cryptography, lxml, cffi, aws-lambda-powertools (Python 3.12)
    this.cryptoLayer = new lambda.LayerVersion(this, 'CryptoLayer', {
      layerVersionName: `EntraVerifiedID-Crypto-${props.stage}`,
      description:      'cryptography + lxml + cffi + aws-lambda-powertools (x86_64, Python 3.12)',
      compatibleArchitectures: [lambda.Architecture.X86_64],
      compatibleRuntimes:      [lambda.Runtime.PYTHON_3_12],
      code: lambda.Code.fromDockerBuild(
        path.join(__dirname, '..', 'layer'),
        { file: 'Dockerfile' },
      ),
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    });

    new cdk.CfnOutput(this, 'CryptoLayerArn', { value: this.cryptoLayer.layerVersionArn });
  }
}

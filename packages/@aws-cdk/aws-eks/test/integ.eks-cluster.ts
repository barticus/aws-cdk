/// !cdk-integ pragma:ignore-assets
import * as ec2 from '@aws-cdk/aws-ec2';
import * as iam from '@aws-cdk/aws-iam';
import { App, CfnOutput, Duration, Token } from '@aws-cdk/core';
import * as eks from '../lib';
import * as hello from './hello-k8s';
import { TestStack } from './util';

class EksClusterStack extends TestStack {
  constructor(scope: App, id: string) {
    super(scope, id);

    // allow all account users to assume this role in order to admin the cluster
    const mastersRole = new iam.Role(this, 'AdminRole', {
      assumedBy: new iam.AccountRootPrincipal(),
    });

    // just need one nat gateway to simplify the test
    const vpc = new ec2.Vpc(this, 'Vpc', { maxAzs: 3, natGateways: 1 });

    // create the cluster with a default nodegroup capacity
    const cluster = new eks.Cluster(this, 'Cluster', {
      vpc,
      mastersRole,
      defaultCapacity: 2,
      version: eks.KubernetesVersion.V1_16,
    });

    // fargate profile for resources in the "default" namespace
    cluster.addFargateProfile('default', {
      selectors: [{ namespace: 'default' }],
    });

    // add some capacity to the cluster. The IAM instance role will
    // automatically be mapped via aws-auth to allow nodes to join the cluster.
    cluster.addCapacity('Nodes', {
      instanceType: new ec2.InstanceType('t2.medium'),
      minCapacity: 3,
    });

    // add bottlerocket nodes
    cluster.addCapacity('BottlerocketNodes', {
      instanceType: new ec2.InstanceType('t3.small'),
      minCapacity: 2,
      machineImageType: eks.MachineImageType.BOTTLEROCKET,
    });

    // spot instances (up to 10)
    cluster.addCapacity('spot', {
      spotPrice: '0.1094',
      instanceType: new ec2.InstanceType('t3.large'),
      maxCapacity: 10,
      bootstrapOptions: {
        kubeletExtraArgs: '--node-labels foo=bar,goo=far',
        awsApiRetryAttempts: 5,
      },
    });

    // inference instances
    cluster.addCapacity('InferenceInstances', {
      instanceType: new ec2.InstanceType('inf1.2xlarge'),
      minCapacity: 1,
    });

    // add a extra nodegroup
    cluster.addNodegroup('extra-ng', {
      instanceType: new ec2.InstanceType('t3.small'),
      minSize: 1,
      // reusing the default capacity nodegroup instance role when available
      nodeRole: cluster.defaultCapacity ? cluster.defaultCapacity.role : undefined,
    });

    // apply a kubernetes manifest
    cluster.addResource('HelloApp', ...hello.resources);

    // deploy the Kubernetes dashboard through a helm chart
    cluster.addChart('dashboard', {
      chart: 'kubernetes-dashboard',
      repository: 'https://kubernetes.github.io/dashboard/',
    });

    // deploy an nginx ingress in a namespace

    const nginxNamespace = cluster.addResource('nginx-namespace', {
      apiVersion: 'v1',
      kind: 'Namespace',
      metadata: {
        name: 'nginx',
      },
    });

    const nginxIngress = cluster.addChart('nginx-ingress', {
      chart: 'nginx-ingress',
      repository: 'https://helm.nginx.com/stable',
      namespace: 'nginx',
      wait: true,
      createNamespace: false,
      timeout: Duration.minutes(15),
    });

    // make sure namespace is deployed before the chart
    nginxIngress.node.addDependency(nginxNamespace);

    // add a service account connected to a IAM role
    cluster.addServiceAccount('MyServiceAccount');

    new CfnOutput(this, 'ClusterEndpoint', { value: cluster.clusterEndpoint });
    new CfnOutput(this, 'ClusterArn', { value: cluster.clusterArn });
    new CfnOutput(this, 'ClusterCertificateAuthorityData', { value: cluster.clusterCertificateAuthorityData });
    new CfnOutput(this, 'ClusterSecurityGroupId', { value: cluster.clusterSecurityGroupId });
    new CfnOutput(this, 'ClusterEncryptionConfigKeyArn', { value: cluster.clusterEncryptionConfigKeyArn });
    new CfnOutput(this, 'ClusterName', { value: cluster.clusterName });
  }
}

// this test uses the bottlerocket image, which is only supported in these
// regions. see https://github.com/aws/aws-cdk/tree/master/packages/%40aws-cdk/aws-eks#bottlerocket
const supportedRegions = [
  'ap-northeast-1',
  'ap-south-1',
  'eu-central-1',
  'us-east-1',
  'us-west-2',
];

const app = new App();

// since the EKS optimized AMI is hard-coded here based on the region,
// we need to actually pass in a specific region.
const stack = new EksClusterStack(app, 'aws-cdk-eks-cluster-test');

if (process.env.CDK_INTEG_ACCOUNT !== '12345678') {

  // only validate if we are about to actually deploy.
  // TODO: better way to determine this, right now the 'CDK_INTEG_ACCOUNT' seems like the only way.

  if (Token.isUnresolved(stack.region)) {
    throw new Error(`region (${stack.region}) cannot be a token and must be configured to one of: ${supportedRegions}`);
  }

  if (!supportedRegions.includes(stack.region)) {
    throw new Error(`region (${stack.region}) must be configured to one of: ${supportedRegions}`);
  }

}


app.synth();

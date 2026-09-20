/**
 * The DynamoDB client, from the environment (ADR-0023 §5): `TABLE_NAME` (required), `DYNAMODB_ENDPOINT`
 * (DynamoDB Local; unset in a deployment) and `AWS_REGION`. No credential is configured here: a
 * deployment's function has an IAM role, a laptop has DynamoDB Local, which takes any key.
 */
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';

export interface DbConfig {
  tableName: string;
  endpoint?: string;
  region?: string;
}

export function createDynamoClient(config: Pick<DbConfig, 'endpoint' | 'region'>): DynamoDBClient {
  const local = Boolean(config.endpoint);
  return new DynamoDBClient({
    ...(config.region ? { region: config.region } : local ? { region: 'local' } : {}),
    ...(config.endpoint ? { endpoint: config.endpoint } : {}),
    // DynamoDB Local signs nothing but the SDK still needs a key pair to sign with.
    ...(local && !process.env.AWS_ACCESS_KEY_ID ? { credentials: { accessKeyId: 'local', secretAccessKey: 'local' } } : {}),
    maxAttempts: 5
  });
}

export function createDocumentClient(client: DynamoDBClient): DynamoDBDocumentClient {
  return DynamoDBDocumentClient.from(client, {
    marshallOptions: { removeUndefinedValues: true, convertClassInstanceToMap: false },
    unmarshallOptions: { wrapNumbers: false }
  });
}

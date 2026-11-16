import type { Deps } from '../core/ports';

/**
 * The Deps used when running in Lambda: a DynamoDB Store and an API Gateway Transport.
 * Not written yet. Until then the deployed connect, disconnect
 * and router handlers fail loudly instead of pretending to work.
 */
export function awsDeps(): Deps {
  throw new Error('AWS adapters are not implemented: DynamoDB store and API Gateway transport');
}

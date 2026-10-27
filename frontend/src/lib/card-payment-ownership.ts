import {createHash} from 'node:crypto';
import {redisCommand} from './workspace-auth/store.ts';
export const cardOwnershipKey = (property: string, order: string) =>
  `sweetfun-os:card-owner:v1:${property}:${createHash('sha256').update(order).digest('hex')}`;
/** Called under the shared property payment lock. Unknown remote writes retain ownership. */
export async function assertNotCardManaged(property: string, orders: string[]) {
  if (!orders.length) return;
  const values = await redisCommand(['MGET', ...orders.map(order => cardOwnershipKey(property, order))]) as unknown[];
  if (!Array.isArray(values) || values.length !== orders.length) throw Error('UNAVAILABLE');
  if (values.some(Boolean)) throw Error('CARD_PAYMENT_REVIEW_REQUIRED');
}

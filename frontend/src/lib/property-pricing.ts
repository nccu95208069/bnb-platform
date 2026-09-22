import type { Channel } from './availability';
export type PricingProperty = 'sweetfun' | 'offland';
export const pricingProperties = {
  sweetfun: { hotel:6188, rooms:{29260:'101',29261:'102',29262:'201',29263:'202',29264:'301',29265:'302'}, plans:{35000:'direct',35007:'airbnb',35005:'booking',35006:'agoda',32116:'owljourney'} },
  offland: { hotel:7180, rooms:{34789:'包棟'}, plans:{42385:'direct',42387:'direct_four',42391:'booking',42392:'agoda',42393:'airbnb',42394:'ctrip'} },
} as const;
export function pricingProperty(id:string) {
  if (id !== 'sweetfun' && id !== 'offland') throw Error('UNSUPPORTED_PRICING_PROPERTY');
  const config=pricingProperties[id];
  return {id:id as PricingProperty,hotel:config.hotel,rooms:config.rooms as Record<number,string>,plans:config.plans as Record<number,Channel>,roomNames:Object.values(config.rooms) as string[],channels:Object.values(config.plans) as Channel[],key:`sweetfun-os:pricing:v1:${id}`};
}

import type {CalendarBooking} from '../../components/calendar/calendar-types';
import type {Principal} from './types.ts';
export function allowedProperty(principal:Principal|null,id:string){return !principal||principal.allProperties||principal.propertyIds.includes(id);}
export function projectBookings(bookings:CalendarBooking[],principal:Principal|null):CalendarBooking[]{
 return bookings.filter(b=>allowedProperty(principal,b.property_id)).map(b=>principal?.viewPrices?b:{...b,room_rate:0,payment_status:'unknown',payments:[],audit_log:[],nightly_amounts:undefined,notes:null,service_note:null,source_payment_label:undefined,price_hidden:true});
}

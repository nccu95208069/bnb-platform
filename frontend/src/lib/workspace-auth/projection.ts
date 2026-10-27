import type {CalendarBooking} from '../../components/calendar/calendar-types';
import type {Principal} from './types.ts';
export function allowedProperty(principal:Principal|null,id:string){return !principal||principal.allProperties||principal.propertyIds.includes(id);}
export function projectBookings(bookings:CalendarBooking[],principal:Principal|null):CalendarBooking[]{
 return bookings.filter(b=>allowedProperty(principal,b.property_id)).map(b=>principal?.viewPrices?b:{...b,room_rate:0,source_order_total_cents:undefined,source_amount_reconciliation:undefined,payment_order_id:undefined,notification_order_id:undefined,source_legacy_payment:undefined,external_order_no:null,owlnest_order_no:null,payment_status:'unknown',payment_review_status:undefined,source_payment_flag:undefined,payments:[],audit_log:[],nightly_amounts:undefined,notes:null,service_note:null,source_notes:undefined,source_notes_unconfirmed:undefined,source_payment_label:undefined,price_hidden:true});
}

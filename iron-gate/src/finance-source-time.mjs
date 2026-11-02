// Source audit time must include an explicit zone. A day-only value, local
// datetime, or rollover date cannot stand in for the original source stamp.
const STAMP = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,6}))?(Z|[+-]\d{2}:\d{2})$/;

export function validSourceRecordedAt(value) {
  if (typeof value !== 'string') return false;
  const match = STAMP.exec(value);
  if (!match) return false;
  const [,year,month,day,hour,minute,second,,zone] = match;
  const y=Number(year), m=Number(month), d=Number(day);
  const daysInMonth=new Date(Date.UTC(y,m,0)).getUTCDate();
  if (y<1000 || m<1 || m>12 || d<1 || d>daysInMonth || Number(hour)>23 ||
    Number(minute)>59 || Number(second)>59) return false;
  if (zone!=='Z') {
    const zoneHour=Number(zone.slice(1,3)), zoneMinute=Number(zone.slice(4,6));
    if (zoneHour>14 || zoneMinute>59 || zoneHour===14 && zoneMinute!==0) return false;
  }
  return Number.isFinite(Date.parse(value));
}

export function sameSourceInstant(stored, source) {
  const sourceMicros = sourceInstantMicros(source);
  if (sourceMicros == null || stored == null) return false;
  // A Date has already lost any sub-millisecond precision. Refuse to call it
  // equal to a source instant that cannot be represented by that Date.
  const storedMicros = stored instanceof Date ?
    BigInt(stored.getTime()) * 1000n : sourceInstantMicros(stored);
  return storedMicros != null && storedMicros === sourceMicros;
}

function sourceInstantMicros(value) {
  if (!validSourceRecordedAt(value)) return null;
  const match = STAMP.exec(value);
  const fraction = match[7] ?? '';
  const wholeSecond = value.replace(/\.\d{1,6}(?=Z|[+-]\d{2}:\d{2}$)/, '');
  return BigInt(Date.parse(wholeSecond)) * 1000n +
    BigInt(fraction.padEnd(6, '0') || '0');
}

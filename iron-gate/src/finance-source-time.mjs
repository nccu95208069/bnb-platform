// Source audit time must include an explicit zone. A day-only value, local
// datetime, or rollover date cannot stand in for the original source stamp.
const STAMP = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,3})?(Z|[+-]\d{2}:\d{2})$/;

export function validSourceRecordedAt(value) {
  if (typeof value !== 'string') return false;
  const match = STAMP.exec(value);
  if (!match) return false;
  const [,year,month,day,hour,minute,second,zone] = match;
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
  return validSourceRecordedAt(source) && stored != null &&
    new Date(stored).getTime()===Date.parse(source);
}

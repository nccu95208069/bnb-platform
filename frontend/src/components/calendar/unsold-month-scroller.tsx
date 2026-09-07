"use client";
import { Fragment, useEffect, useLayoutEffect, useMemo, useRef, useState, type RefObject } from "react";
import { ShieldCheck } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { availabilityApi, inventoryLabels, priceText, type AvailabilityResult, type Channel, type RoomNight } from "@/lib/availability";
import { PAYMENT_SANDBOX } from "@/lib/payment-workflow";
import { availabilityFeatures } from "@/lib/availability-features";
import { PricePair, roomNightStyle } from "./availability-presentation";
import { useCalendarPreferences } from "./calendar-preferences";
import { addDays, addMonths, formatMonthLabel, localTodayIso, startOfMonth, WEEKDAY_LABELS, monthStarts } from "./calendar-utils";

const MONTHS = monthStarts("2025-01-01", 36);
type Props = {
 anchor:string; jump:number; property:string; room:string; channel:Channel; cycle:1|2; refresh:number;
 search:string; onlyAvailable:boolean; onVisibleMonth:(month:string)=>void;
 onSelect:(cell:RoomNight)=>void; onSelectDay:(day:string)=>void;
};
function MonthPanel({month,root,props}: {month:string;root:RefObject<HTMLDivElement|null>;props:Props}) {
 const ref=useRef<HTMLElement>(null);
 const [near,setNear]=useState(false),[data,setData]=useState<AvailabilityResult|null>(null),[error,setError]=useState(false),[retry,setRetry]=useState(0);
 const {property,room,channel,cycle,refresh,search,onlyAvailable}=props;
 const expandedWeeks=useCalendarPreferences(s=>s.expandedWeeks),setExpandedWeeks=useCalendarPreferences(s=>s.setExpandedWeeks);
 const period=useMemo(()=>({start:month,end:addMonths(month,1)}),[month]);
 const monthDays=useMemo(()=>{
  const weekday=(new Date(month+"T12:00Z").getUTCDay()+6)%7;
  const dayCount=(Date.parse(period.end)-Date.parse(month))/86400000;
  return Array.from({length:Math.ceil((weekday+dayCount)/7)*7},(_,i)=>addDays(month,i-weekday));
 },[month,period.end]);
 useEffect(()=>{
  const observer=new IntersectionObserver(entries=>setNear(entries.some(e=>e.isIntersecting)),{root:root.current,rootMargin:"900px 0px"});
  if(ref.current)observer.observe(ref.current);
  return ()=>observer.disconnect();
 },[root]);
 useEffect(()=>{
  if(!near)return;
  let active=true;
  const abort=new AbortController();
  const query={start:period.start,end:period.end,rooms:room==="all"?[]:[room],channel,demo_cycle:cycle};
  const params=new URLSearchParams({start:query.start,end:query.end,rooms:query.rooms.join(","),channel,property});
  const request=PAYMENT_SANDBOX?availabilityApi.check(query):fetch(`/api/v1/availability?${params}`,{cache:"no-store",signal:abort.signal}).then(async r=>{if(!r.ok)throw Error("SOURCE_UNAVAILABLE");return r.json() as Promise<AvailabilityResult>;});
  request.then(value=>{if(active){setData(value);setError(false);}}).catch(()=>{if(active)setError(true);});
  return ()=>{active=false;abort.abort();};
 },[near,period,room,channel,cycle,property,refresh,retry]);
 // Do not display cached cells under a newly selected room/channel while loading.
 const correct = data?.query.channel===channel && JSON.stringify(data?.query.rooms)===JSON.stringify(room==="all"?[]:[room]);
 const cells = correct && !error ? data?.cells ?? [] : [];
 const hidePrice=!!data?.price_hidden;
 const matches=(c:RoomNight)=>(!onlyAvailable||c.state==="available")&&(!search.trim()||`${c.room} ${inventoryLabels[c.state]} ${c.reason}`.toLowerCase().includes(search.trim().toLowerCase()));
 const openCell=props.onSelect, selectDay=props.onSelectDay;
 return <section ref={ref} data-unsold-month={month} className="border-b bg-card">
  <h2 className="flex h-12 items-center justify-between border-b px-3 text-base font-semibold">{formatMonthLabel(month)}<span className="text-xs font-normal text-muted-foreground">{correct && !error ? `${cells.filter(c=>c.state==="available").length} 未售房晚`:""}</span></h2>
  {error && <button className="w-full bg-amber-50 p-2 text-sm" onClick={()=>setRetry(v=>v+1)}>此月份暫時無法讀取，點此重試</button>}

              <div className="overflow-hidden rounded-xl border bg-card">
                <div className="grid grid-cols-7 border-b bg-muted/30">
                  {WEEKDAY_LABELS.map((d) => (
                    <div
                      key={d}
                      className="p-2 text-center text-xs text-muted-foreground"
                    >
                      {d}
                    </div>
                  ))}
                </div>
                <div className="grid grid-cols-7">
                  {monthDays.map((day, index) => {
                    const weekKey = monthDays[Math.floor(index / 7) * 7];
                    const expanded = expandedWeeks.includes(weekKey);
                    const inMonth = day >= period.start && day < period.end;
                    const dayCells = cells.filter((c) => c.date === day);
                    const shown = dayCells.filter(
                      (c) =>
                        c.state !== "sold" && c.state !== "past" && matches(c),
                    );
                    const count = dayCells.filter(
                      (c) => c.state === "available",
                    ).length;
                    return (
                      <Fragment key={day}>
                        <div
                          data-unsold-date={day}
                          className={cn(
                            "min-h-44 border-b border-r p-1 sm:p-2",
                            !inMonth && "bg-muted/25",
                          )}
                        >
                          <button
                            className="flex w-full items-center justify-between pb-1 text-left text-xs"
                            aria-label={`${day} 查看日曆`}
                            onClick={() => selectDay(day)}
                          >
                            <span
                              className={cn(
                                "flex size-6 items-center justify-center rounded-full",
                                day === localTodayIso()
                                  ? "bg-primary text-primary-foreground"
                                  : "",
                              )}
                            >
                              {Number(day.slice(-2))}
                            </span>
                            {inMonth && (
                              <span className="hidden text-[10px] text-muted-foreground sm:inline">
                                未售 {count}
                              </span>
                            )}
                          </button>
                          {shown
                            .slice(0, expanded ? shown.length : 3)
                            .map((c, i) => (
                              <button
                                key={c.room}
                                title={`${c.date} ${c.room} 房 ${inventoryLabels[c.state]}`}
                                aria-label={`${c.date} ${c.room} 房 ${inventoryLabels[c.state]} ${hidePrice ? "" : priceText(c.pricing?.current_price)}`}
                                onClick={() => openCell(c)}
                                className={cn(
                                  "mb-1 w-full rounded-md border px-1 py-1 text-left sm:flex sm:items-center sm:justify-between",
                                  roomNightStyle(c),
                                  !expanded && i === 2 && "hidden sm:flex",
                                )}
                              >
                                <span className="flex items-center gap-0.5 text-[10px] font-medium sm:text-xs">
                                  {c.room}
                                  {availabilityFeatures.pricingReview && c.pricing &&
                                    !c.pricing.eligible &&
                                    c.state === "available" && (
                                      <ShieldCheck className="hidden size-3 sm:inline" />
                                    )}
                                </span>
                                <PricePair
                                  cell={c}
                                  compact
                                  hidePrice={hidePrice}
                                />
                              </button>
                            ))}
                          {!expanded && shown.length > 2 && (
                            <button
                              className="w-full text-left text-[9px] text-muted-foreground sm:hidden"
                              aria-expanded={false}
                              aria-label={`${day} 展開其餘房間`}
                              onClick={() =>
                                setExpandedWeeks((v) => [...v, weekKey])
                              }
                            >
                              另 {shown.length - 2} 房
                            </button>
                          )}
                          {!expanded && shown.length > 3 && (
                            <button
                              className="hidden w-full text-left text-[10px] text-muted-foreground sm:block"
                              aria-expanded={false}
                              aria-label={`${day} 展開其餘房間`}
                              onClick={() =>
                                setExpandedWeeks((v) => [...v, weekKey])
                              }
                            >
                              另 {shown.length - 3} 房
                            </button>
                          )}
                          {inMonth && shown.length === 0 && (
                            <p className="pt-2 text-[10px] text-muted-foreground">
                              {!correct || error ? (error ? "待重試" : "載入中") : day < (data?.asof ?? localTodayIso())
                                ? "已過期"
                                : search.trim()
                                  ? "無符合條件"
                                  : onlyAvailable
                                    ? "無可售"
                                    : "無未售"}
                            </p>
                          )}
                        </div>
                        {expanded && index % 7 === 6 && (
                          <Button
                            variant="ghost"
                            size="sm"
                            className="col-span-7 h-8 w-full rounded-none border-b bg-muted/20 text-xs"
                            aria-label={`${weekKey} 收合這一列`}
                            aria-expanded={true}
                            onClick={() =>
                              setExpandedWeeks((v) =>
                                v.filter((w) => w !== weekKey),
                              )
                            }
                          >
                            收合這一列
                          </Button>
                        )}
                      </Fragment>
                    );
                  })}
                </div>
              </div>

 </section>;
}
export function UnsoldMonthScroller(props:Props) {
 const root=useRef<HTMLDivElement>(null);
 useLayoutEffect(()=>{
  const container=root.current;if(!container)return;
  let frame=0;
  const measure=()=>{cancelAnimationFrame(frame);frame=requestAnimationFrame(()=>{
   const height=window.visualViewport?.height ?? window.innerHeight;
   const top=container.getBoundingClientRect().top;
   container.style.height=`${Math.max(280,height-Math.max(0,top)-8)}px`;
  });};
  measure();
  const observer=new ResizeObserver(measure);
  if(container.parentElement)observer.observe(container.parentElement);
  window.addEventListener("resize",measure);window.visualViewport?.addEventListener("resize",measure);
  return ()=>{observer.disconnect();cancelAnimationFrame(frame);window.removeEventListener("resize",measure);window.visualViewport?.removeEventListener("resize",measure);};
 },[]);
 const scrollingMonth=useRef<string|null>(null);
 const lastJump=useRef(props.jump);
 const onVisible=useRef(props.onVisibleMonth);
 useEffect(()=>{onVisible.current=props.onVisibleMonth;},[props.onVisibleMonth]);
 const visible=useRef(startOfMonth(props.anchor));
 useLayoutEffect(()=>{
  const month=startOfMonth(props.anchor),forced=lastJump.current!==props.jump;
  lastJump.current=props.jump;
  if(!forced && scrollingMonth.current===month){scrollingMonth.current=null;return;}
  const container=root.current,node=container?.querySelector<HTMLElement>(`[data-unsold-month="${month}"]`);
  if(!container||!node)return;
  const day=forced?node.querySelector<HTMLElement>(`[data-unsold-date="${props.anchor}"]`):null;
  const target=day??node;
  visible.current=month;
  container.scrollTo({top:Math.max(0,target.getBoundingClientRect().top-container.getBoundingClientRect().top+container.scrollTop-(day?48:0)),behavior:"instant"});
 },[props.anchor,props.jump]);
 useEffect(()=>{
  const container=root.current;if(!container)return;
  let frame=0;
  const update=()=>{
   frame=0;
   const bounds=container.getBoundingClientRect();
   const best=[...container.querySelectorAll<HTMLElement>("[data-unsold-month]")].map(node=>{const r=node.getBoundingClientRect();return{month:node.dataset.unsoldMonth!,height:Math.max(0,Math.min(r.bottom,bounds.bottom)-Math.max(r.top,bounds.top))};}).sort((a,b)=>b.height-a.height)[0];
   if(best?.height>0&&visible.current!==best.month){visible.current=best.month;scrollingMonth.current=best.month;onVisible.current(best.month);}
  };
  const scroll=()=>{if(!frame)frame=requestAnimationFrame(update);};
  container.addEventListener("scroll",scroll,{passive:true});
  return ()=>{container.removeEventListener("scroll",scroll);cancelAnimationFrame(frame);};
 },[]);
 return <div ref={root} role="region" aria-label="未售月曆，可上下捲動月份" tabIndex={0} className="h-[calc(100dvh-280px)] min-h-[280px] overflow-y-auto overscroll-contain rounded-xl border bg-card shadow-sm">
  {MONTHS.map(month=><MonthPanel key={month} month={month} root={root} props={props}/>)}
 </div>;
}

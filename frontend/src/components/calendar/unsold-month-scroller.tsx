"use client";
import {useIntlLocale} from "@/components/i18n/language-provider";
import {useT} from "@/components/i18n/language-provider";
import { Fragment, useLayoutEffect, useMemo, useRef, useState } from "react";
import { ShieldCheck } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { inventoryLabels, priceText, type AvailabilityResult, type RoomNight } from "@/lib/availability";
import { availabilityFeatures } from "@/lib/availability-features";
import { PricePair, roomNightStyle } from "./availability-presentation";
import { useMonthPosition } from "./use-month-position";
import { useCalendarPreferences } from "./calendar-preferences";
import { manualMonthWeekMinHeight, unsoldMonthRoomLimits } from "./month-layout";
import { addDays, addMonths, formatMonthLabel, localTodayIso, WEEKDAY_LABELS, monthStarts } from "./calendar-utils";

const MONTHS = monthStarts("2025-01-01", 36);
type Props = {
 anchor:string; jump:number;
 search:string; onlyAvailable:boolean; onVisibleMonth:(month:string)=>void;
 onSelect:(cell:RoomNight)=>void; onSelectDay:(day:string)=>void;
 getMonth:(start:string,end:string)=>{data:AvailabilityResult|null;error:string;savedAt?:number|null}; onRetry:()=>void;
};
function MonthPanel({month,props,viewportHeight}: {month:string;props:Props;viewportHeight:number}) {
const uiLocale = useIntlLocale();

  const uiText = useT();

 const {search,onlyAvailable}=props;
 const expandedWeeks=useCalendarPreferences(s=>s.expandedWeeks),setExpandedWeeks=useCalendarPreferences(s=>s.setExpandedWeeks);
 const monthWeekAuto=useCalendarPreferences(s=>s.monthWeekAuto);
 const monthWeekDensity=useCalendarPreferences(s=>s.monthWeekDensity);
 const {mobile:mobileLimit,desktop:desktopLimit}=unsoldMonthRoomLimits(monthWeekAuto,monthWeekDensity);
 const manualWeekHeight=monthWeekAuto?undefined:Math.max(96,manualMonthWeekMinHeight(viewportHeight,monthWeekDensity));
 const period=useMemo(()=>({start:month,end:addMonths(month,1)}),[month]);
 const {data,error,savedAt}=props.getMonth(period.start,period.end);
 const monthDays=useMemo(()=>{
  const weekday=(new Date(month+"T12:00Z").getUTCDay()+6)%7;
  const dayCount=(Date.parse(period.end)-Date.parse(month))/86400000;
  return Array.from({length:Math.ceil((weekday+dayCount)/7)*7},(_,i)=>addDays(month,i-weekday));
 },[month,period.end]);
 // The parent cache already isolates property, room, channel and access scope.
 const correct = !!data;
 const cells = correct && !error ? data?.cells ?? [] : [];
 const hidePrice=!!data?.price_hidden;
 const matches=(c:RoomNight)=>(!onlyAvailable||c.state==="available")&&(!search.trim()||`${c.room} ${inventoryLabels[c.state]} ${c.reason}`.toLowerCase().includes(search.trim().toLowerCase()));
 const openCell=props.onSelect, selectDay=props.onSelectDay;
 return <section data-unsold-month={month} data-position-month={month} className="border-b bg-card">
  <h2 className="flex h-12 items-center justify-between border-b px-3 text-base font-semibold">{formatMonthLabel(month, uiLocale)}<span className="text-xs font-normal text-muted-foreground">{correct && !error ? uiText("{0} 未售房晚", [cells.filter(c=>c.state==="available").length]):""}</span></h2>
  {savedAt && <p className="border-b bg-sky-50 px-3 py-1 text-xs text-sky-950">上次讀取：{new Date(savedAt).toLocaleString(uiLocale, { timeZone: 'Asia/Taipei' })} · 正在核對</p>}
  {error && <button className="w-full bg-amber-50 p-2 text-sm" onClick={props.onRetry}>{uiText("此月份暫時無法讀取，點此重試")}</button>}

              <div className="overflow-hidden rounded-xl border bg-card">
                <div className="grid grid-cols-7 border-b bg-muted/30">
                  {uiText(WEEKDAY_LABELS.map((d) => (
                    <div
                      key={uiText(`週${d}`)}
                      className="truncate px-0.5 py-2 text-center text-[0.625rem] text-muted-foreground"
                    >
                      {uiText(`週${d}`)}
                    </div>
                  )))}
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
                          data-position-date={day}
                          style={{ minHeight: manualWeekHeight }}
                          className={cn(
                            "min-h-44 border-b border-r p-1 sm:p-2",
                            !inMonth && "bg-muted/25",
                          )}
                        >
                          <button
                            className="flex w-full items-center justify-between pb-1 text-left text-xs"
                            aria-label={uiText("{0} 查看日曆", [day])}
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
                              <span className="hidden text-[0.625rem] text-muted-foreground sm:inline">
                                {uiText("未售")}{correct && !error ? count : "—"}
                              </span>
                            )}
                          </button>
                          {shown
                            .slice(0, expanded ? shown.length : desktopLimit)
                            .map((c, i) => (
                              <button
                                key={c.room}
                                title={uiText("{0} {1} 房 {2}", [c.date,c.room,inventoryLabels[c.state]])}
                                aria-label={uiText("{0} {1} 房 {2} {3}", [c.date,c.room,inventoryLabels[c.state],hidePrice ? "" : priceText(c.pricing?.current_price)])}
                                onClick={() => openCell(c)}
                                className={cn(
                                  "mb-1 w-full rounded-md border px-1 py-1 text-left sm:flex sm:items-center sm:justify-between",
                                  roomNightStyle(c),
                                  !expanded && i >= mobileLimit && "hidden sm:flex",
                                )}
                              >
                                <span className="flex items-center gap-0.5 text-[0.625rem] font-medium sm:text-xs">
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
                          {!expanded && shown.length > mobileLimit && (
                            <button
                              className="w-full text-left text-[0.5625rem] text-muted-foreground sm:hidden"
                              aria-expanded={false}
                              aria-label={uiText("{0} 展開其餘房間", [day])}
                              onClick={() =>
                                setExpandedWeeks((v) => [...v, weekKey])
                              }
                            >
                              {uiText("另")}{shown.length - mobileLimit} {uiText("房")}</button>
                          )}
                          {!expanded && shown.length > desktopLimit && (
                            <button
                              className="hidden w-full text-left text-[0.625rem] text-muted-foreground sm:block"
                              aria-expanded={false}
                              aria-label={uiText("{0} 展開其餘房間", [day])}
                              onClick={() =>
                                setExpandedWeeks((v) => [...v, weekKey])
                              }
                            >
                              {uiText("另")}{shown.length - desktopLimit} {uiText("房")}</button>
                          )}
                          {inMonth && shown.length === 0 && (
                            <p className="pt-2 text-[0.625rem] text-muted-foreground">
                              {!correct || error ? (error ? "待重試" : "載入中") : day < (data?.asof ?? localTodayIso())
                                ? uiText("已過期")
                                : search.trim()
                                  ? uiText("無符合條件")
                                  : onlyAvailable
                                    ? uiText("無可售")
                                    : uiText("無未售")}
                            </p>
                          )}
                        </div>
                        {expanded && index % 7 === 6 && (
                          <Button
                            variant="ghost"
                            size="sm"
                            className="col-span-7 h-8 w-full rounded-none border-b bg-muted/20 text-xs"
                            aria-label={uiText("{0} 收合這一列", [weekKey])}
                            aria-expanded={true}
                            onClick={() =>
                              setExpandedWeeks((v) =>
                                v.filter((w) => w !== weekKey),
                              )
                            }
                          >
                            {uiText("收合這一列")}</Button>
                        )}
                      </Fragment>
                    );
                  })}
                </div>
              </div>

 </section>;
}
export function UnsoldMonthScroller(props:Props) {
  const uiText = useT();

 const root=useRef<HTMLDivElement>(null);
 const [viewportHeight,setViewportHeight]=useState(520);
 useLayoutEffect(()=>{
  const container=root.current;if(!container)return;
  let frame=0;
  const measure=()=>{cancelAnimationFrame(frame);frame=requestAnimationFrame(()=>{
   // visualViewport can be shorter than the page viewport on mobile browsers,
   // leaving a one-week calendar above a large blank area. Match the sold
   // calendar's layout viewport measurement so the scroller fills the page.
   const height=window.innerHeight;
   const top=container.getBoundingClientRect().top;
   const measuredHeight=Math.max(320,Math.floor(height-Math.max(0,top)-12));
   container.style.height=`${measuredHeight}px`;
   setViewportHeight(measuredHeight);
  });};
  measure();
  const observer=new ResizeObserver(measure);
  if(container.parentElement)observer.observe(container.parentElement);
  window.addEventListener("resize",measure);window.visualViewport?.addEventListener("resize",measure);
  return ()=>{observer.disconnect();cancelAnimationFrame(frame);window.removeEventListener("resize",measure);window.visualViewport?.removeEventListener("resize",measure);};
 },[]);
 const historyRevision=useCalendarPreferences(s=>s.historyRevision);
 // Month mode starts at its header; the selected day remains highlighted
 // inside the month instead of hiding the earlier weeks above it.
 const monthAnchor=props.anchor.slice(0,7)+"-01";
 useMonthPosition(root,monthAnchor,props.jump+historyRevision,props.onVisibleMonth);
 return <div ref={root} style={{overflowAnchor:"none"}} role="region" aria-label={uiText("未售月曆，可上下捲動月份")} tabIndex={0} className="h-[calc(100dvh-280px)] min-h-[320px] overflow-y-auto overscroll-contain rounded-xl border bg-card shadow-sm">
  {MONTHS.map(month=><MonthPanel key={month} month={month} props={props} viewportHeight={viewportHeight}/>)}
 </div>;
}

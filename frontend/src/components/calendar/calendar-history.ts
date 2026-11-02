"use client";

import { useEffect, useState } from "react";
import { useCalendarPreferences } from "./calendar-preferences";
import { availabilityFeatures } from "@/lib/availability-features";
import { channelLabels } from "@/lib/availability";
import { localTodayIso } from "./calendar-utils";

type State = ReturnType<typeof useCalendarPreferences.getState>;
function snapshot(s: State) {
  return {
    selectedPropertyIds: s.selectedPropertyIds,
    mode: s.mode,
    view: s.view,
    anchorDate: s.anchorDate,
    availabilityRoom: s.availabilityRoom,
    availabilityChannel: s.availabilityChannel,
    availabilityCycle: availabilityFeatures.demoPriceCycles
      ? s.availabilityCycle
      : (1 as const),
    availabilityOnly: s.availabilityOnly,
    searchQuery: s.searchQuery,
    expandedWeeks: s.expandedWeeks,
    availabilitySelection: s.availabilitySelection,
    selectedBookingId: s.selectedBookingId,
    pricingPreview: availabilityFeatures.pricingReview
      ? s.pricingPreview
      : null,
    pricingGoal: s.pricingGoal,
    pricingMission: availabilityFeatures.pricingReview
      ? s.pricingMission
      : null,
  };
}
function validDate(value: string | null): value is string {
  return (
    !!value &&
    /^\d{4}-\d{2}-\d{2}$/.test(value) &&
    !Number.isNaN(Date.parse(value)) &&
    new Date(value).toISOString().slice(0, 10) === value
  );
}
const rooms = ["101", "102", "201", "202", "301", "302", "包棟"];
function fromUrl(s: State, freshVisit = false) {
  const p = new URLSearchParams(location.search);
  const next = snapshot(s);
  if (p.has("properties")) next.selectedPropertyIds = [...new Set((p.get("properties") ?? "").split(",").filter(id=>["sweetfun","offland"].includes(id)))];
  const mode = p.get("mode"),
    view = p.get("view"),
    day = p.get("date"),
    room = p.get("room"),
    channel = p.get("channel");
  if (mode === "sold" || mode === "unsold") next.mode = mode;
  else if (p.has("order")) next.mode = "sold";
  if (view === "month" || view === "week" || view === "day") next.view = view;
  // A saved/reopened calendar URL is not a request to revisit its old month.
  // Only links targeting an order or a room night need an initial historical date.
  const targeted = Boolean(p.get("order") || p.get("stay"));
  next.anchorDate = (!freshVisit || targeted) && validDate(day) ? day : localTodayIso();
  if (room && (room === "all" || rooms.includes(room)))
    next.availabilityRoom = room;
  if (channel && channel in channelLabels)
    next.availabilityChannel = channel as State["availabilityChannel"];
  if (availabilityFeatures.demoPriceCycles && p.has("cycle"))
    next.availabilityCycle = p.get("cycle") === "2" ? 2 : 1;
  next.searchQuery = p.get("q") ?? "";
  next.availabilityOnly = p.get("available") === "1";
  next.expandedWeeks = freshVisit && !targeted ? [] : (p.get("expanded") ?? "").split(",").filter(validDate);
  const stay = p.get("stay")?.split("_");
  next.availabilitySelection =
    stay && validDate(stay[0]) && rooms.includes(stay[1])
      ? { date: stay[0], room: stay[1] }
      : null;
  next.selectedBookingId = p.get("order");
  // Proposals live in history.state, never in a shared URL or localStorage.
  next.pricingPreview = null;
  next.pricingMission = null;
  return next;
}
function url(s: ReturnType<typeof snapshot>) {
  const p = new URLSearchParams({
    mode: s.mode,
    view: s.view,
    date: s.anchorDate,
    room: s.availabilityRoom,
    channel: s.availabilityChannel,
  });
  if (s.selectedPropertyIds?.length) p.set("properties",s.selectedPropertyIds.join(","));
  if (availabilityFeatures.demoPriceCycles)
    p.set("cycle", String(s.availabilityCycle));
  if (s.searchQuery) p.set("q", s.searchQuery);
  if (s.availabilityOnly) p.set("available", "1");
  if (s.expandedWeeks.length) p.set("expanded", s.expandedWeeks.join(","));
  if (s.mode === "unsold" && s.availabilitySelection)
    p.set(
      "stay",
      `${s.availabilitySelection.date}_${s.availabilitySelection.room}`,
    );
  if (s.mode === "sold" && s.selectedBookingId)
    p.set("order", s.selectedBookingId);
  return `/calendar?${p}`;
}

// Batch one interaction (date + view, for example) into one browser history entry.
// Restore the store on Back/Forward instead of merely changing the address bar.
export function useCalendarHistory() {
  const [ready, setReady] = useState(false);
  useEffect(() => {
    let active = true,
      restoring = false,
      queued = false;
    const initial = fromUrl(useCalendarPreferences.getState(), true);
    const visibleInitial = snapshot({
      ...useCalendarPreferences.getState(),
      ...initial,
    });
    useCalendarPreferences.setState(visibleInitial);
    history.replaceState(
      { ...history.state, bnbCalendar: visibleInitial },
      "",
      url(visibleInitial),
    );
    let current = JSON.stringify(visibleInitial);
    const unsubscribe = useCalendarPreferences.subscribe(() => {
      if (restoring || queued) return;
      queued = true;
      queueMicrotask(() => {
        queued = false;
        if (!active || restoring || location.pathname !== "/calendar") return;
        const next = snapshot(useCalendarPreferences.getState()),
          encoded = JSON.stringify(next);
        if (encoded === current) return;
        const previous = history.state?.bnbCalendar;
        current = encoded;
        // Typing and server acknowledgements update the same page visit.
        const navigation = (value: typeof next) =>
          JSON.stringify({ ...value, pricingGoal: null, pricingMission: null });
        if (previous && navigation(previous) === navigation(next)) {
          history.replaceState(
            { ...history.state, bnbCalendar: next },
            "",
            url(next),
          );
          return;
        }
        // Explicit toggles are new visits. Calling asynchronous history.back()
        // here races the next view's layout and can restore an unrelated date.
        history.pushState(
          { ...history.state, bnbCalendar: next },
          "",
          url(next),
        );
      });
    });
    const restore = (event: PopStateEvent) => {
      if (location.pathname !== "/calendar") return;
      restoring = true;
      const value =
        event.state?.bnbCalendar ?? fromUrl(useCalendarPreferences.getState());
      const visibleValue = snapshot({
        ...useCalendarPreferences.getState(),
        ...value,
      });
      current = JSON.stringify(visibleValue);
      useCalendarPreferences.setState({
        ...visibleValue,
        historyRevision: useCalendarPreferences.getState().historyRevision + 1,
      });
      restoring = false;
    };
    window.addEventListener("popstate", restore);
    const returnToCurrentMonth = () => {
      if (location.pathname !== "/calendar") return;
      const s = useCalendarPreferences.getState();
      // Don't interrupt an open booking, room-night selection or pricing review.
      if (s.selectedBookingId || s.availabilitySelection || s.pricingPreview || s.pricingMission) return;
      const today = localTodayIso();
      if (s.anchorDate.slice(0, 7) === today.slice(0, 7)) return;
      restoring = true;
      const next = snapshot({ ...s, anchorDate: today, expandedWeeks: [] });
      current = JSON.stringify(next);
      useCalendarPreferences.setState({ ...next, historyRevision: s.historyRevision + 1 });
      history.replaceState({ ...history.state, bnbCalendar: next }, "", url(next));
      restoring = false;
    };
    let wasHidden = document.visibilityState === "hidden";
    const visibility = () => {
      if (document.visibilityState === "hidden") { wasHidden = true; return; }
      if (document.visibilityState !== "visible" || !wasHidden) return;
      wasHidden = false;
      returnToCurrentMonth();
    };
    const pageShow = (event: PageTransitionEvent) => {
      if (event.persisted) returnToCurrentMonth();
    };
    document.addEventListener("visibilitychange", visibility);
    window.addEventListener("pageshow", pageShow);
    queueMicrotask(() => {
      if (active) setReady(true);
    });
    return () => {
      active = false;
      unsubscribe();
      window.removeEventListener("popstate", restore);
      document.removeEventListener("visibilitychange", visibility);
      window.removeEventListener("pageshow", pageShow);
    };
  }, []);
  return ready;
}

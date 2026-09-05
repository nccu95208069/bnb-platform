"use client";

import { create } from "zustand";
import { persist } from "zustand/middleware";

import { localTodayIso } from "./calendar-utils";
import type { Mission } from "@/lib/payment-workflow";
import type { Channel, PricingPreview } from "@/lib/availability";
import type { CalendarProperty, CalendarView } from "./calendar-types";

type CalendarNavigationAction = "previous" | "next" | "today";

type CalendarNavigationRequest = {
  id: number;
  action: CalendarNavigationAction;
};

type CalendarPreferenceState = {
  expandedWeeks: string[];
  setExpandedWeeks: (
    value: string[] | ((current: string[]) => string[]),
  ) => void;
  selectedBookingId: string | null;
  setSelectedBookingId: (id: string | null) => void;
  availabilitySelection: { room: string; date: string } | null;
  setAvailabilitySelection: (
    selection: { room: string; date: string } | null,
  ) => void;
  availabilityOnly: boolean;
  setAvailabilityOnly: (value: boolean) => void;
  pricingPreview: (PricingPreview & { review_key: string }) | null;
  setPricingPreview: (
    preview: (PricingPreview & { review_key: string }) | null,
  ) => void;
  pricingGoal: string;
  setPricingGoal: (goal: string) => void;
  pricingMission: Mission | null;
  setPricingMission: (mission: Mission | null) => void;
  historyRevision: number;
  properties: CalendarProperty[];
  selectedPropertyIds: string[];
  view: CalendarView;
  mode: "sold" | "unsold";
  anchorDate: string;
  availabilityCycle: 1 | 2;
  availabilityChannel: Channel;
  availabilityRoom: string;
  setAvailabilityCycle: (cycle: 1 | 2) => void;
  setAvailabilityChannel: (channel: Channel) => void;
  setAvailabilityRoom: (room: string) => void;
  setMode: (mode: "sold" | "unsold") => void;
  setAnchorDate: (value: string | ((current: string) => string)) => void;
  searchQuery: string;
  mobileSearchOpen: boolean;
  mobileMenuOpen: boolean;
  mobilePeriodLabel: string;
  navigationRequest: CalendarNavigationRequest | null;
  setProperties: (properties: CalendarProperty[]) => void;
  toggleProperty: (propertyId: string) => void;
  selectAllProperties: () => void;
  setView: (view: CalendarView) => void;
  setSearchQuery: (query: string) => void;
  setMobileSearchOpen: (open: boolean) => void;
  setMobileMenuOpen: (open: boolean) => void;
  setMobilePeriodLabel: (label: string) => void;
  requestCalendarNavigation: (action: CalendarNavigationAction) => void;
};

export const useCalendarPreferences = create<CalendarPreferenceState>()(
  persist(
    (set) => ({
      expandedWeeks: [],
      setExpandedWeeks: (value) =>
        set((s) => ({
          expandedWeeks:
            typeof value === "function" ? value(s.expandedWeeks) : value,
        })),
      selectedBookingId: null,
      setSelectedBookingId: (selectedBookingId) => set({ selectedBookingId }),
      availabilitySelection: null,
      setAvailabilitySelection: (availabilitySelection) =>
        set({ availabilitySelection }),
      availabilityOnly: false,
      setAvailabilityOnly: (availabilityOnly) => set({ availabilityOnly }),
      pricingPreview: null,
      setPricingPreview: (pricingPreview) => set({ pricingPreview }),
      pricingGoal: "請定價 Agent 核對此範圍，產生正式調價計畫並交由業主核准。",
      setPricingGoal: (pricingGoal) => set({ pricingGoal }),
      pricingMission: null,
      setPricingMission: (pricingMission) => set({ pricingMission }),
      historyRevision: 0,
      properties: [],
      selectedPropertyIds: [],
      view: "month",
      mode: "sold",
      anchorDate: localTodayIso(),
      availabilityCycle: 1,
      availabilityChannel: "direct",
      availabilityRoom: "all",
      setAvailabilityCycle: (availabilityCycle) => set({ availabilityCycle }),
      setAvailabilityChannel: (availabilityChannel) =>
        set({ availabilityChannel }),
      setAvailabilityRoom: (availabilityRoom) => set({ availabilityRoom }),
      setMode: (mode) => set({ mode }),
      setAnchorDate: (value) =>
        set((state) => ({
          anchorDate:
            typeof value === "function" ? value(state.anchorDate) : value,
        })),
      searchQuery: "",
      mobileSearchOpen: false,
      mobileMenuOpen: false,
      mobilePeriodLabel: "訂單日曆",
      navigationRequest: null,
      setProperties: (properties) =>
        set((state) => {
          const validIds = new Set(properties.map((property) => property.id));
          const retained = state.selectedPropertyIds.filter((id) =>
            validIds.has(id),
          );
          return {
            properties,
            selectedPropertyIds: retained.length
              ? retained
              : properties.map((property) => property.id),
          };
        }),
      toggleProperty: (propertyId) =>
        set((state) => {
          const isSelected = state.selectedPropertyIds.includes(propertyId);
          if (isSelected && state.selectedPropertyIds.length === 1)
            return state;
          return {
            selectedPropertyIds: isSelected
              ? state.selectedPropertyIds.filter((id) => id !== propertyId)
              : [...state.selectedPropertyIds, propertyId],
          };
        }),
      selectAllProperties: () =>
        set((state) => ({
          selectedPropertyIds: state.properties.map((property) => property.id),
        })),
      setView: (view) => set({ view }),
      setSearchQuery: (searchQuery) => set({ searchQuery }),
      setMobileSearchOpen: (mobileSearchOpen) =>
        set(
          mobileSearchOpen
            ? { mobileSearchOpen: true }
            : { mobileSearchOpen: false, searchQuery: "" },
        ),
      setMobileMenuOpen: (mobileMenuOpen) => set({ mobileMenuOpen }),
      setMobilePeriodLabel: (mobilePeriodLabel) => set({ mobilePeriodLabel }),
      requestCalendarNavigation: (action) =>
        set((state) => ({
          navigationRequest: {
            id: (state.navigationRequest?.id ?? 0) + 1,
            action,
          },
        })),
    }),
    {
      name: "sweetfun-os-calendar-preferences",
      partialize: (state) => ({
        selectedPropertyIds: state.selectedPropertyIds,
        view: state.view,
        mode: state.mode,
        anchorDate: state.anchorDate,
        availabilityCycle: state.availabilityCycle,
        availabilityChannel: state.availabilityChannel,
        availabilityRoom: state.availabilityRoom,
      }),
    },
  ),
);

"use client";

import { create } from "zustand";
import { persist } from "zustand/middleware";

import type { CalendarProperty, CalendarView } from "./calendar-types";

type CalendarPreferenceState = {
  properties: CalendarProperty[];
  selectedPropertyIds: string[];
  view: CalendarView;
  searchQuery: string;
  mobileSearchOpen: boolean;
  setProperties: (properties: CalendarProperty[]) => void;
  toggleProperty: (propertyId: string) => void;
  selectAllProperties: () => void;
  setView: (view: CalendarView) => void;
  setSearchQuery: (query: string) => void;
  setMobileSearchOpen: (open: boolean) => void;
};

export const useCalendarPreferences = create<CalendarPreferenceState>()(
  persist(
    (set) => ({
      properties: [],
      selectedPropertyIds: [],
      view: "month",
      searchQuery: "",
      mobileSearchOpen: false,
      setProperties: (properties) =>
        set((state) => {
          const validIds = new Set(properties.map((property) => property.id));
          const retained = state.selectedPropertyIds.filter((id) => validIds.has(id));
          return {
            properties,
            selectedPropertyIds: retained.length ? retained : properties.map((property) => property.id),
          };
        }),
      toggleProperty: (propertyId) =>
        set((state) => {
          const isSelected = state.selectedPropertyIds.includes(propertyId);
          if (isSelected && state.selectedPropertyIds.length === 1) return state;
          return {
            selectedPropertyIds: isSelected
              ? state.selectedPropertyIds.filter((id) => id !== propertyId)
              : [...state.selectedPropertyIds, propertyId],
          };
        }),
      selectAllProperties: () =>
        set((state) => ({ selectedPropertyIds: state.properties.map((property) => property.id) })),
      setView: (view) => set({ view }),
      setSearchQuery: (searchQuery) => set({ searchQuery }),
      setMobileSearchOpen: (mobileSearchOpen) => set({ mobileSearchOpen }),
    }),
    {
      name: "sweetfun-os-calendar-preferences",
      partialize: (state) => ({
        selectedPropertyIds: state.selectedPropertyIds,
        view: state.view,
      }),
    },
  ),
);

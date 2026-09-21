# Daili device draft library

The read-only integration endpoint `/api/v1/room-quote-library` uses the existing scoped quote credential. It publishes a minimal projection of already-published price and booking snapshots. It does not publish prices, change inventory or expose guest/booking data. Content-derived version changes when projected prices/availability change; a matching version returns metadata with no cells.

Only direct/官網 prices are included. Draft source price limit7days; unhealthy booking observations yield unknown. This is explicitly preview_only. Actual send revalidates using the existing live quote endpoint, retaining60second confirmed-quote checks. iOS refreshes on foreground/message/active view; notification-based guaranteed immediate synchronization is not claimed.

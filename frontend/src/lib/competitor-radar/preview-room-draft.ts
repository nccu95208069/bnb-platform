import { extractRoomFeatures } from "./rooms";
import type { CompetitorRadarAnalysis } from "./types";

/** Room title is narrower evidence than page-wide text (extra-person fees, bed counts, navigation). */
export function prioritizeRoomTitleCapacity(analysis: CompetitorRadarAnalysis): CompetitorRadarAnalysis {
  const warnings = [...analysis.warnings];
  const canonicalRooms = analysis.canonicalRooms.map(room => {
    const title = extractRoomFeatures(room.name);
    if (title.capacity === undefined || title.capacity === room.capacity) return room;
    if (room.capacity !== undefined) {
      warnings.push(`「${room.name}」內文人數擷取與標題不同；已以明確房型標題的 ${title.capacity} 人為準，請核對。`);
    }
    return { ...room, capacity: title.capacity };
  });
  return { ...analysis, canonicalRooms, warnings };
}

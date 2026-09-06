export const CHANNELS = ["booking", "direct", "agoda", "ctrip", "owljourney", "airbnb", "other"] as const;
export type PaletteId = "mist" | "earth" | "coast" | "slate" | "jewel";
export type ChannelColors = Record<(typeof CHANNELS)[number], { background: string; foreground: string }>;
function colors(backgrounds: string[], foreground: string | string[]): ChannelColors {
  return Object.fromEntries(CHANNELS.map((channel, i) => [channel, { background: backgrounds[i], foreground: typeof foreground === "string" ? foreground : foreground[i] }])) as ChannelColors;
}
export const CALENDAR_PALETTES: { id: PaletteId; name: string; description: string; colors: ChannelColors }[] = [
  { id: "mist", name: "霧感莫蘭迪", description: "低彩度、柔霧底色，長時間看也舒服。", colors: colors(["#D9E4EB", "#DDE8DD", "#E5DFF0", "#EFE2D2", "#DBDFEF", "#EFDDDF", "#E3E5E7"], "#29343C") },
  { id: "earth", name: "復古暖陽", description: "芥末黃、赤陶橘與咖啡棕，像老旅館的旅行海報。", colors: colors(["#E8BA54", "#C8CA85", "#774937", "#E5A078", "#F2D6A5", "#9A432D", "#DAD0B8"], ["#35251B", "#30351F", "#FFFFFF", "#35251B", "#35251B", "#FFFFFF", "#35251B"]) },
  { id: "coast", name: "白瓷彩線", description: "留白為主，用彩色細框與側線辨識平台，輕盈俐落。", colors: colors(Array(7).fill("#FFFFFF"), ["#176080", "#1E6C4E", "#77458E", "#975310", "#46559B", "#A23559", "#58616B"]) },
  { id: "slate", name: "黑白編輯", description: "純黑、石墨灰與紙白，像報刊排版，以平台文字辨識。", colors: colors(["#242424", "#EEEEEE", "#565656", "#FFFFFF", "#D1D1D1", "#3B3B3B", "#E2E2E2"], ["#FFFFFF", "#242424", "#FFFFFF", "#242424", "#242424", "#FFFFFF", "#242424"]) },
  { id: "jewel", name: "寶石濃彩", description: "藍寶石、祖母綠與酒紅，飽和又有質感。", colors: colors(["#125A80", "#17634F", "#653E85", "#914D19", "#3F4887", "#922F50", "#465467"], "#FFFFFF") },
];
export const DEFAULT_PALETTE: PaletteId = "mist";
export function isPaletteId(value: unknown): value is PaletteId {
  return CALENDAR_PALETTES.some((palette) => palette.id === value);
}
export function paletteById(id: PaletteId) {
  return CALENDAR_PALETTES.find((palette) => palette.id === id) ?? CALENDAR_PALETTES[0];
}
export function platformAppearance(id: PaletteId, channel: (typeof CHANNELS)[number]) {
  const color = paletteById(id).colors[channel];
  const borderColor = id === "coast" ? color.foreground
    : `color-mix(in srgb, ${color.background} 80%, ${color.foreground})`;
  return { backgroundColor: color.background, color: color.foreground, borderColor,
    boxShadow: id === "coast" ? `inset 0 0 0 1px ${color.foreground}, inset 3px 0 0 ${color.foreground}` : "none" };
}
export function paletteCss(id: PaletteId) {
  return `:root{${CHANNELS.map((channel) => {
    const style = platformAppearance(id, channel);
    return `--platform-${channel}-bg:${style.backgroundColor};--platform-${channel}-fg:${style.color};--platform-${channel}-border:${style.borderColor};--platform-${channel}-shadow:${style.boxShadow}`;
  }).join(";")}}`;
}

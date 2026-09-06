export const CHANNELS = ["booking", "direct", "agoda", "ctrip", "owljourney", "airbnb", "other"] as const;
export type PaletteId = "mist" | "earth" | "coast" | "slate" | "jewel";
export type ChannelColors = Record<(typeof CHANNELS)[number], { background: string; foreground: string }>;
function colors(backgrounds: string[], foreground: string | string[]): ChannelColors {
  return Object.fromEntries(CHANNELS.map((channel, i) => [channel, { background: backgrounds[i], foreground: typeof foreground === "string" ? foreground : foreground[i] }])) as ChannelColors;
}
export const CALENDAR_PALETTES: { id: PaletteId; name: string; description: string; colors: ChannelColors }[] = [
  { id: "mist", name: "霧感莫蘭迪", description: "低彩度、柔霧底色，長時間看也舒服。", colors: colors(["#D9E4EB", "#DDE8DD", "#E5DFF0", "#EFE2D2", "#DBDFEF", "#EFDDDF", "#E3E5E7"], "#29343C") },
  { id: "earth", name: "奶油花園", description: "奶油黃、蜜桃與嫩葉綠，明亮溫暖，像彩色手帳。", colors: colors(["#CFE6F2", "#E5ECAD", "#EACFE0", "#FFE09C", "#DACDF0", "#FFC6C0", "#EAE2CF"], "#35352E") },
  { id: "coast", name: "海島晴空", description: "海水藍、薄荷綠與珊瑚粉，清爽鮮明，輕快有精神。", colors: colors(["#24759B", "#78CDC2", "#6866B3", "#F3B367", "#AED8EE", "#EDA0AC", "#C6D5DA"], ["#FFFFFF", "#153B40", "#FFFFFF", "#44301E", "#173D51", "#492335", "#2A3E47"]) },
  { id: "slate", name: "午夜絲絨", description: "墨藍、松綠與深莓紫，深色底搭亮字，沉靜俐落。", colors: colors(["#172D48", "#193D39", "#382B4D", "#4A3529", "#283553", "#482F40", "#343C45"], "#EEF0F6") },
  { id: "jewel", name: "皇家琉璃", description: "鈷藍、翡翠與紅寶石，高飽和實色，濃郁而清晰。", colors: colors(["#2450C7", "#007D66", "#8024AD", "#B55310", "#3F46B8", "#B82359", "#4B5B72"], "#FFFFFF") },
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
  const borderColor = `color-mix(in srgb, ${color.background} 80%, ${color.foreground})`;
  return { backgroundColor: color.background, color: color.foreground, borderColor,
    boxShadow: "none" };
}
export function paletteCss(id: PaletteId) {
  return `:root{${CHANNELS.map((channel) => {
    const style = platformAppearance(id, channel);
    return `--platform-${channel}-bg:${style.backgroundColor};--platform-${channel}-fg:${style.color};--platform-${channel}-border:${style.borderColor};--platform-${channel}-shadow:${style.boxShadow}`;
  }).join(";")}}`;
}

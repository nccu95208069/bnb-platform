export const CHANNELS = ["booking", "direct", "agoda", "ctrip", "owljourney", "airbnb", "other"] as const;
export type PaletteId = "mist" | "earth" | "coast" | "slate" | "jewel";
export type ChannelColors = Record<(typeof CHANNELS)[number], { background: string; foreground: string }>;
function colors(backgrounds: string[], foreground: string): ChannelColors {
  return Object.fromEntries(CHANNELS.map((channel, i) => [channel, { background: backgrounds[i], foreground }])) as ChannelColors;
}
export const CALENDAR_PALETTES: { id: PaletteId; name: string; description: string; colors: ChannelColors }[] = [
  { id: "mist", name: "霧感莫蘭迪", description: "低彩度、柔霧底色，長時間看也舒服。", colors: colors(["#D9E4EB", "#DDE8DD", "#E5DFF0", "#EFE2D2", "#DBDFEF", "#EFDDDF", "#E3E5E7"], "#29343C") },
  { id: "earth", name: "暖杏大地", description: "陶土、鼠尾草與奶茶色，溫暖自然。", colors: colors(["#DDE1DC", "#E2E5CE", "#E7DAD6", "#F1DFC3", "#E2DDE7", "#EDD5CE", "#E6E0D6"], "#42372F") },
  { id: "coast", name: "海岸微光", description: "清爽海藍與薄荷色，明亮而不刺眼。", colors: colors(["#CCE7F3", "#D1ECE3", "#E2DDF4", "#F7E8C7", "#D5E0F6", "#F5DEE5", "#DEE8EB"], "#243C4B") },
  { id: "slate", name: "暮色石板", description: "灰藍、苔綠與煙紫，安靜沉穩。", colors: colors(["#455E70", "#506653", "#695B72", "#786047", "#535F7C", "#785760", "#5C6268"], "#FFFFFF") },
  { id: "jewel", name: "寶石濃彩", description: "藍寶石、祖母綠與酒紅，飽和又有質感。", colors: colors(["#125A80", "#17634F", "#653E85", "#914D19", "#3F4887", "#922F50", "#465467"], "#FFFFFF") },
];
export const DEFAULT_PALETTE: PaletteId = "mist";
export function isPaletteId(value: unknown): value is PaletteId {
  return CALENDAR_PALETTES.some((palette) => palette.id === value);
}
export function paletteById(id: PaletteId) {
  return CALENDAR_PALETTES.find((palette) => palette.id === id) ?? CALENDAR_PALETTES[0];
}
export function paletteCss(id: PaletteId) {
  return `:root{${Object.entries(paletteById(id).colors).map(([channel, color]) => `--platform-${channel}-bg:${color.background};--platform-${channel}-fg:${color.foreground}`).join(";")}}`;
}

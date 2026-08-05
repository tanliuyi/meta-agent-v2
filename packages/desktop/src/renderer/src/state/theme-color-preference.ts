import { preferencesStorage } from "./preferences-store.ts";
import type { ResolvedTheme } from "./theme-preference.ts";

export const THEME_COLOR_PREFERENCES = ["blue", "teal", "violet", "rose", "amber", "custom"] as const;
export type ThemeColorPreference = (typeof THEME_COLOR_PREFERENCES)[number];
export type ThemeColorPresetId = Exclude<ThemeColorPreference, "custom">;

export interface ThemeColorPreset {
  id: ThemeColorPresetId;
  label: string;
  light: string;
  dark: string;
}

export interface ThemeColorPreferences {
  preference: ThemeColorPreference;
  customColor: string;
}

export const THEME_COLOR_PRESETS: readonly ThemeColorPreset[] = [
  { id: "blue", label: "海蓝", light: "#2563EB", dark: "#60A5FA" },
  { id: "teal", label: "青碧", light: "#0F766E", dark: "#5EEAD4" },
  { id: "violet", label: "紫藤", light: "#7C3AED", dark: "#A78BFA" },
  { id: "rose", label: "玫红", light: "#E11D48", dark: "#FB7185" },
  { id: "amber", label: "琥珀", light: "#B45309", dark: "#FBBF24" },
];

export const DEFAULT_THEME_COLOR_PREFERENCE: ThemeColorPreference = "blue";
export const DEFAULT_CUSTOM_THEME_COLOR = "#2563EB";
export const THEME_COLOR_STORAGE_KEY = "pi-desktop:theme-color";
export const CUSTOM_THEME_COLOR_STORAGE_KEY = "pi-desktop:theme-custom-color";
export const THEME_ACCENT_PROPERTY = "--theme-accent";
export const THEME_ACCENT_FOREGROUND_PROPERTY = "--theme-accent-foreground";

interface ThemeColorTarget {
  dataset: Record<string, string | undefined>;
  style: Pick<CSSStyleDeclaration, "setProperty">;
}

interface InitializeThemeColorOptions {
  root?: ThemeColorTarget;
  resolvedTheme: ResolvedTheme;
  readStoredPreference?: () => string | null;
  readStoredCustomColor?: () => string | null;
}

export function parseThemeColorPreference(value: string | null): ThemeColorPreference {
  return THEME_COLOR_PREFERENCES.some((preference) => preference === value)
    ? (value as ThemeColorPreference)
    : DEFAULT_THEME_COLOR_PREFERENCE;
}

export function normalizeHexColor(value: string | null): string | null {
  if (!value) return null;
  const normalized = value.trim().toUpperCase();
  if (/^#[0-9A-F]{6}$/u.test(normalized)) return normalized;
  const short = /^#([0-9A-F])([0-9A-F])([0-9A-F])$/u.exec(normalized);
  return short ? `#${short[1]}${short[1]}${short[2]}${short[2]}${short[3]}${short[3]}` : null;
}

export function readStoredThemeColorPreferences(
  readPreference: () => string | null = () => preferencesStorage.getItem(THEME_COLOR_STORAGE_KEY),
  readCustomColor: () => string | null = () => preferencesStorage.getItem(CUSTOM_THEME_COLOR_STORAGE_KEY),
): ThemeColorPreferences {
  try {
    return {
      preference: parseThemeColorPreference(readPreference()),
      customColor: normalizeHexColor(readCustomColor()) ?? DEFAULT_CUSTOM_THEME_COLOR,
    };
  } catch {
    return { preference: DEFAULT_THEME_COLOR_PREFERENCE, customColor: DEFAULT_CUSTOM_THEME_COLOR };
  }
}

export function writeStoredThemeColorPreference(
  preference: ThemeColorPreference,
  writeValue: (value: string) => void = (value) => preferencesStorage.setItem(THEME_COLOR_STORAGE_KEY, value),
): void {
  try {
    writeValue(preference);
  } catch {
    // 当前窗口仍可应用主题色，持久化失败不应阻断交互。
  }
}

export function writeStoredCustomThemeColor(
  color: string,
  writeValue: (value: string) => void = (value) => preferencesStorage.setItem(CUSTOM_THEME_COLOR_STORAGE_KEY, value),
): void {
  try {
    writeValue(normalizeHexColor(color) ?? DEFAULT_CUSTOM_THEME_COLOR);
  } catch {
    // 同上，持久化失败不影响当前窗口。
  }
}

export function themeColorHex(
  preference: ThemeColorPreference,
  customColor: string,
  resolvedTheme: ResolvedTheme,
): string {
  if (preference === "custom") return normalizeHexColor(customColor) ?? DEFAULT_CUSTOM_THEME_COLOR;
  const preset = THEME_COLOR_PRESETS.find(({ id }) => id === preference) ?? THEME_COLOR_PRESETS[0];
  return preset[resolvedTheme];
}

export function applyThemeColorPreferences(
  root: ThemeColorTarget,
  preferences: ThemeColorPreferences,
  resolvedTheme: ResolvedTheme,
): void {
  const color = themeColorHex(preferences.preference, preferences.customColor, resolvedTheme);
  const accent = preferences.preference === "custom" ? accessibleAccent(color, resolvedTheme) : presetAccent(color);
  root.dataset.themeColor = preferences.preference;
  root.style.setProperty(THEME_ACCENT_PROPERTY, accent.hsl);
  root.style.setProperty(THEME_ACCENT_FOREGROUND_PROPERTY, accent.foreground);
}

export function initializeThemeColor(options: InitializeThemeColorOptions): ThemeColorPreferences {
  const root = options.root ?? document.documentElement;
  const preferences = readStoredThemeColorPreferences(options.readStoredPreference, options.readStoredCustomColor);
  applyThemeColorPreferences(root, preferences, options.resolvedTheme);
  return preferences;
}

function accessibleAccent(hex: string, resolvedTheme: ResolvedTheme): { hsl: string; foreground: string } {
  const rgb = hexToRgb(hex);
  const hsl = rgbToHsl(rgb);
  const lightnessRange = resolvedTheme === "light" ? [34, 54] : [58, 72];
  let normalizedLightness = Math.min(lightnessRange[1], Math.max(lightnessRange[0], hsl.lightness));
  let normalizedRgb = hslToRgb({ ...hsl, lightness: normalizedLightness });
  const surfaceLuminance = resolvedTheme === "light" ? 1 : relativeLuminance({ red: 26, green: 26, blue: 26 });
  while (contrastRatio(relativeLuminance(normalizedRgb), surfaceLuminance) < 3) {
    normalizedLightness += resolvedTheme === "light" ? -1 : 1;
    if (normalizedLightness < 20 || normalizedLightness > 82) break;
    normalizedRgb = hslToRgb({ ...hsl, lightness: normalizedLightness });
  }
  return {
    hsl: `${formatChannel(hsl.hue)} ${formatChannel(hsl.saturation)}% ${formatChannel(normalizedLightness)}%`,
    foreground: readableForeground(normalizedRgb),
  };
}

function presetAccent(hex: string): { hsl: string; foreground: string } {
  const rgb = hexToRgb(hex);
  const hsl = rgbToHsl(rgb);
  return {
    hsl: `${formatChannel(hsl.hue)} ${formatChannel(hsl.saturation)}% ${formatChannel(hsl.lightness)}%`,
    foreground: readableForeground(rgb),
  };
}

function readableForeground(rgb: RgbColor): string {
  const luminance = relativeLuminance(rgb);
  const whiteContrast = contrastRatio(luminance, 1);
  const darkContrast = contrastRatio(luminance, relativeLuminance({ red: 15, green: 23, blue: 42 }));
  return whiteContrast >= darkContrast ? "0 0% 100%" : "222 47% 11%";
}

interface RgbColor {
  red: number;
  green: number;
  blue: number;
}

interface HslColor {
  hue: number;
  saturation: number;
  lightness: number;
}

function hexToRgb(hex: string): RgbColor {
  return {
    red: Number.parseInt(hex.slice(1, 3), 16),
    green: Number.parseInt(hex.slice(3, 5), 16),
    blue: Number.parseInt(hex.slice(5, 7), 16),
  };
}

function rgbToHsl({ red, green, blue }: RgbColor): HslColor {
  const normalized = [red / 255, green / 255, blue / 255];
  const maximum = Math.max(...normalized);
  const minimum = Math.min(...normalized);
  const delta = maximum - minimum;
  const lightness = (maximum + minimum) / 2;
  let hue = 0;
  if (delta !== 0) {
    if (maximum === normalized[0]) hue = ((normalized[1] - normalized[2]) / delta) % 6;
    else if (maximum === normalized[1]) hue = (normalized[2] - normalized[0]) / delta + 2;
    else hue = (normalized[0] - normalized[1]) / delta + 4;
    hue *= 60;
    if (hue < 0) hue += 360;
  }
  const saturation = delta === 0 ? 0 : delta / (1 - Math.abs(2 * lightness - 1));
  return { hue, saturation: saturation * 100, lightness: lightness * 100 };
}

function hslToRgb({ hue, saturation, lightness }: HslColor): RgbColor {
  const normalizedSaturation = saturation / 100;
  const normalizedLightness = lightness / 100;
  const chroma = (1 - Math.abs(2 * normalizedLightness - 1)) * normalizedSaturation;
  const section = hue / 60;
  const secondary = chroma * (1 - Math.abs((section % 2) - 1));
  const [red, green, blue] =
    section < 1
      ? [chroma, secondary, 0]
      : section < 2
        ? [secondary, chroma, 0]
        : section < 3
          ? [0, chroma, secondary]
          : section < 4
            ? [0, secondary, chroma]
            : section < 5
              ? [secondary, 0, chroma]
              : [chroma, 0, secondary];
  const offset = normalizedLightness - chroma / 2;
  return { red: (red + offset) * 255, green: (green + offset) * 255, blue: (blue + offset) * 255 };
}

function relativeLuminance({ red, green, blue }: RgbColor): number {
  const channels = [red, green, blue].map((channel) => {
    const normalized = channel / 255;
    return normalized <= 0.04045 ? normalized / 12.92 : ((normalized + 0.055) / 1.055) ** 2.4;
  });
  return channels[0] * 0.2126 + channels[1] * 0.7152 + channels[2] * 0.0722;
}

function contrastRatio(first: number, second: number): number {
  return (Math.max(first, second) + 0.05) / (Math.min(first, second) + 0.05);
}

function formatChannel(value: number): string {
  return String(Math.round(value * 10) / 10);
}

import { Button } from "@renderer/shared/ui/button";
import { Input } from "@renderer/shared/ui/input";
import { Popover } from "@renderer/shared/ui/popover";
import { PopoverContent } from "@renderer/shared/ui/popover-content";
import { PopoverTrigger } from "@renderer/shared/ui/popover-trigger";
import { type CSSProperties, type KeyboardEvent, type PointerEvent, useEffect, useRef, useState } from "react";

interface ColorPickerProps {
  value: string;
  onValueChange(value: string): void;
  className?: string;
  "aria-label"?: string;
}

interface HsvColor {
  hue: number;
  saturation: number;
  value: number;
}

type ColorPickerHueStyle = CSSProperties & { "--color-picker-hue": number };

/** shadcn/ui primitives 组合的 HEX 调色板。 */
export function ColorPicker({
  value,
  onValueChange,
  className,
  "aria-label": ariaLabel = "选择颜色",
}: ColorPickerProps) {
  const normalizedValue = requireHex(value);
  const hsv = hexToHsv(normalizedValue);
  const [draft, setDraft] = useState(normalizedValue);
  const pendingColor = useRef<string | undefined>(undefined);
  const previewFrame = useRef<number | undefined>(undefined);

  useEffect(() => setDraft(normalizedValue), [normalizedValue]);
  useEffect(
    () => () => {
      if (previewFrame.current !== undefined) window.cancelAnimationFrame(previewFrame.current);
    },
    [],
  );

  const updateColor = (next: HsvColor) => onValueChange(hsvToHex(next));

  const previewColor = (next: HsvColor) => {
    pendingColor.current = hsvToHex(next);
    if (previewFrame.current !== undefined) return;
    previewFrame.current = window.requestAnimationFrame(() => {
      previewFrame.current = undefined;
      if (pendingColor.current !== undefined) onValueChange(pendingColor.current);
      pendingColor.current = undefined;
    });
  };

  const updateSaturationValue = (clientX: number, clientY: number, element: HTMLDivElement) => {
    const bounds = element.getBoundingClientRect();
    previewColor({
      hue: hsv.hue,
      saturation: clamp(((clientX - bounds.left) / bounds.width) * 100, 0, 100),
      value: clamp(100 - ((clientY - bounds.top) / bounds.height) * 100, 0, 100),
    });
  };

  const handlePalettePointer = (event: PointerEvent<HTMLDivElement>) => {
    if (event.type === "pointerdown") event.currentTarget.setPointerCapture(event.pointerId);
    if (event.type === "pointerdown" || event.currentTarget.hasPointerCapture(event.pointerId)) {
      updateSaturationValue(event.clientX, event.clientY, event.currentTarget);
    }
  };

  const handlePaletteKey = (event: KeyboardEvent<HTMLDivElement>) => {
    const step = event.shiftKey ? 5 : 1;
    let saturation = hsv.saturation;
    let nextValue = hsv.value;
    if (event.key === "ArrowLeft") saturation -= step;
    else if (event.key === "ArrowRight") saturation += step;
    else if (event.key === "ArrowUp") nextValue += step;
    else if (event.key === "ArrowDown") nextValue -= step;
    else return;
    event.preventDefault();
    updateColor({
      hue: hsv.hue,
      saturation: clamp(saturation, 0, 100),
      value: clamp(nextValue, 0, 100),
    });
  };

  const commitDraft = () => {
    const normalized = normalizeHex(draft);
    if (!normalized) {
      setDraft(normalizedValue);
      return;
    }
    setDraft(normalized);
    onValueChange(normalized);
  };

  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button variant="outline" className={className} aria-label={ariaLabel} title={ariaLabel} aria-haspopup="dialog">
          <span
            className="size-4 shrink-0 rounded-sm border border-foreground/15"
            style={{ background: normalizedValue }}
          />
          <span className="font-mono text-xs">{normalizedValue}</span>
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-64 p-3" align="end" sideOffset={8} aria-label={`${ariaLabel}调色板`}>
        <div
          role="slider"
          tabIndex={0}
          aria-label="饱和度与亮度"
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={Math.round(hsv.saturation)}
          aria-valuetext={`饱和度 ${Math.round(hsv.saturation)}%，亮度 ${Math.round(hsv.value)}%`}
          className="color-picker-saturation relative h-36 w-full touch-none overflow-hidden rounded-lg outline-none ring-offset-popover focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
          style={{ "--color-picker-hue": hsv.hue } as ColorPickerHueStyle}
          onPointerDown={handlePalettePointer}
          onPointerMove={handlePalettePointer}
          onKeyDown={handlePaletteKey}
        >
          <span
            className="color-picker-thumb pointer-events-none absolute size-4 -translate-x-1/2 -translate-y-1/2 rounded-full"
            style={{
              left: `${hsv.saturation}%`,
              top: `${100 - hsv.value}%`,
              background: normalizedValue,
            }}
          />
        </div>

        <input
          type="range"
          aria-label="色相"
          min={0}
          max={360}
          value={Math.round(hsv.hue)}
          className="color-picker-hue mt-3 h-3 w-full cursor-pointer appearance-none rounded-full"
          onChange={(event) => previewColor({ ...hsv, hue: Number(event.target.value) })}
        />

        <div className="mt-3 flex items-center gap-2">
          <span
            className="size-7 shrink-0 rounded-md border border-border"
            style={{ background: normalizedValue }}
            aria-hidden="true"
          />
          <Input
            aria-label="十六进制颜色"
            aria-invalid={!normalizeHex(draft)}
            className="font-mono uppercase"
            value={draft}
            maxLength={7}
            spellCheck={false}
            onChange={(event) => {
              const nextDraft = event.target.value;
              setDraft(nextDraft);
              const normalized = normalizeHex(nextDraft);
              if (normalized) onValueChange(normalized);
            }}
            onBlur={commitDraft}
            onKeyDown={(event) => {
              if (event.key === "Enter") commitDraft();
              else if (event.key === "Escape") setDraft(normalizedValue);
            }}
          />
        </div>
      </PopoverContent>
    </Popover>
  );
}

export function hexToHsv(hex: string): HsvColor {
  const normalized = requireHex(hex);
  const red = Number.parseInt(normalized.slice(1, 3), 16) / 255;
  const green = Number.parseInt(normalized.slice(3, 5), 16) / 255;
  const blue = Number.parseInt(normalized.slice(5, 7), 16) / 255;
  const maximum = Math.max(red, green, blue);
  const minimum = Math.min(red, green, blue);
  const delta = maximum - minimum;
  let hue = 0;
  if (delta !== 0) {
    if (maximum === red) hue = ((green - blue) / delta) % 6;
    else if (maximum === green) hue = (blue - red) / delta + 2;
    else hue = (red - green) / delta + 4;
    hue *= 60;
    if (hue < 0) hue += 360;
  }
  return {
    hue,
    saturation: maximum === 0 ? 0 : (delta / maximum) * 100,
    value: maximum * 100,
  };
}

export function hsvToHex({ hue, saturation, value }: HsvColor): string {
  const normalizedHue = ((hue % 360) + 360) % 360;
  const normalizedSaturation = clamp(saturation, 0, 100) / 100;
  const normalizedValue = clamp(value, 0, 100) / 100;
  const chroma = normalizedValue * normalizedSaturation;
  const section = normalizedHue / 60;
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
  const offset = normalizedValue - chroma;
  return `#${[red, green, blue]
    .map((channel) =>
      Math.round((channel + offset) * 255)
        .toString(16)
        .padStart(2, "0"),
    )
    .join("")}`.toUpperCase();
}

function normalizeHex(value: string): string | null {
  const normalized = value.trim().toUpperCase();
  return /^#[0-9A-F]{6}$/u.test(normalized) ? normalized : null;
}

function requireHex(value: string): string {
  const normalized = normalizeHex(value);
  if (!normalized) throw new TypeError("ColorPicker requires a #RRGGBB value");
  return normalized;
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value));
}

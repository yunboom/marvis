/**
 * Marvis wordmark / sigil. 1:1 vector copy of docs/assets/logo-light.svg —
 * keep this file and the SVG in sync.
 *
 * react-native-svg does not resolve CSS `currentColor`, so callers must pass
 * `color` explicitly. For theme-aware usage, pair with `useColorScheme` +
 * `THEME` token from `@/lib/theme`.
 */
import Svg, { Defs, Mask, Polygon, Rect } from "react-native-svg";
import { THEME } from "@/lib/theme";
import { useColorScheme } from "@/lib/use-color-scheme";

interface MarvisLogoProps {
  size?: number;
  color?: string;
}

export function MarvisLogo({ size = 48, color }: MarvisLogoProps) {
  const { isDarkColorScheme } = useColorScheme();
  const resolvedColor =
    color ?? (isDarkColorScheme ? THEME.dark.foreground : THEME.light.foreground);

  return (
    <Svg width={size} height={size} viewBox="0 0 80 80">
      <Defs>
        <Mask id="marvis-logo-mask">
          <Rect width="80" height="80" fill="white" />
          <Polygon
            fill="black"
            transform="scale(0.8)"
            points="27,70 27,30 39,30 50,50 61,30 73,30 73,70 63,70 63,46 54,62 46,62 37,46 37,70"
          />
        </Mask>
      </Defs>
      <Rect width="80" height="80" rx="21" fill={resolvedColor} mask="url(#marvis-logo-mask)" />
    </Svg>
  );
}

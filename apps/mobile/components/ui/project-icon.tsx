/**
 * Mobile ProjectIcon — RN port of
 * `packages/views/projects/components/project-icon.tsx`. Renders the
 * project's emoji icon, or the same solid kanban glyph as web when it has
 * none.
 *
 * Why a square View wrapper + explicit lineHeight:
 *   Emoji glyphs do not respect the latin-text baseline metrics — on iOS
 *   they render with a visual extent ~10-15% larger than `fontSize`,
 *   centered on the baseline. `<Text>` clips content to `lineHeight`, so a
 *   `lineHeight: font-size` (the previous `leading-none` form) trimmed the
 *   top and bottom of the emoji. Setting `lineHeight = fontSize * 1.2`
 *   gives the glyph enough vertical room; the surrounding View pins a
 *   stable square footprint so flex parents using `items-center` /
 *   `items-start` align siblings against a predictable box instead of the
 *   emoji's drifting baseline.
 */
import { View } from "react-native";
import Svg, { Path } from "react-native-svg";
import { Text } from "@/components/ui/text";
import { THEME } from "@/lib/theme";
import { useColorScheme } from "@/lib/use-color-scheme";

export type ProjectIconSize = "sm" | "md" | "lg";

const SIZE: Record<ProjectIconSize, { box: number; font: number }> = {
  sm: { box: 18, font: 14 },
  md: { box: 22, font: 16 },
  lg: { box: 28, font: 22 },
};

// Phosphor "Kanban" (fill weight), the glyph web renders via
// @phosphor-icons/react.
const KANBAN_FILL_PATH =
  "M160,56v96a8,8,0,0,1-8,8H112a8,8,0,0,1-8-8V56a8,8,0,0,1,8-8h40A8,8,0,0,1,160,56Zm64-8H184a8,8,0,0,0-8,8v52a4,4,0,0,0,4,4h48a4,4,0,0,0,4-4V56A8,8,0,0,0,224,48Zm4,80H180a4,4,0,0,0-4,4v44a16,16,0,0,0,16,16h24a16,16,0,0,0,16-16V132A4,4,0,0,0,228,128ZM80,48H40a8,8,0,0,0-8,8v52a4,4,0,0,0,4,4H84a4,4,0,0,0,4-4V56A8,8,0,0,0,80,48Zm4,80H36a4,4,0,0,0-4,4v76a16,16,0,0,0,16,16H72a16,16,0,0,0,16-16V132A4,4,0,0,0,84,128Z";

interface Props {
  icon?: string | null;
  size?: ProjectIconSize;
}

export function ProjectIcon({ icon, size = "sm" }: Props) {
  const { box, font } = SIZE[size];
  const { colorScheme } = useColorScheme();

  return (
    <View
      style={{
        width: box,
        height: box,
        alignItems: "center",
        justifyContent: "center",
      }}
    >
      {icon ? (
        <Text style={{ fontSize: font, lineHeight: Math.round(font * 1.2) }}>
          {icon}
        </Text>
      ) : (
        <Svg width={font} height={font} viewBox="0 0 256 256">
          <Path d={KANBAN_FILL_PATH} fill={THEME[colorScheme].mutedForeground} />
        </Svg>
      )}
    </View>
  );
}

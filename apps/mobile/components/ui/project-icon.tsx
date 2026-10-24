/**
 * Mobile ProjectIcon — RN port of
 * `packages/views/projects/components/project-icon.tsx`. Renders the
 * project's emoji or line glyph (`icon:<name>`), falling back to the
 * folder glyph.
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
import type { ComponentProps } from "react";
import { View } from "react-native";
import { MaterialCommunityIcons } from "@expo/vector-icons";
import { useTheme } from "expo-router";
import { parseProjectIcon, type ProjectGlyph } from "@marvis/core/projects/config";
import { Text } from "@/components/ui/text";

export type ProjectIconSize = "sm" | "md" | "lg";

const SIZE: Record<ProjectIconSize, { box: number; font: number }> = {
  sm: { box: 18, font: 14 },
  md: { box: 22, font: 16 },
  lg: { box: 28, font: 22 },
};

// Closest outline equivalents of the web/desktop lucide glyphs.
const GLYPH_NAME: Record<ProjectGlyph, ComponentProps<typeof MaterialCommunityIcons>["name"]> = {
  folder: "folder-outline",
  briefcase: "briefcase-outline",
  rocket: "rocket-launch-outline",
  target: "target",
  flag: "flag-outline",
  compass: "compass-outline",
  layers: "layers-outline",
  box: "package-variant-closed",
  code: "code-tags",
  terminal: "console",
  git_branch: "source-branch",
  database: "database-outline",
  server: "server",
  cloud: "cloud-outline",
  smartphone: "cellphone",
  monitor: "monitor",
  palette: "palette-outline",
  pen_tool: "fountain-pen-tip",
  book_open: "book-open-outline",
  file_text: "file-document-outline",
  megaphone: "bullhorn-outline",
  chart_line: "chart-line",
  lightbulb: "lightbulb-outline",
  sparkles: "creation-outline",
  users: "account-multiple-outline",
  shield: "shield-outline",
  bug: "bug-outline",
  wrench: "wrench-outline",
  calendar: "calendar-blank-outline",
  mountain: "image-filter-hdr",
  leaf: "leaf",
  feather: "feather",
};

interface Props {
  icon?: string | null;
  size?: ProjectIconSize;
}

export function ProjectIcon({ icon, size = "sm" }: Props) {
  const { box, font } = SIZE[size];
  const { colors } = useTheme();
  const parsed = parseProjectIcon(icon);

  return (
    <View
      style={{
        width: box,
        height: box,
        alignItems: "center",
        justifyContent: "center",
      }}
    >
      {parsed?.kind === "emoji" ? (
        <Text style={{ fontSize: font, lineHeight: Math.round(font * 1.2) }}>
          {parsed.emoji}
        </Text>
      ) : (
        <MaterialCommunityIcons
          name={GLYPH_NAME[parsed?.glyph ?? "folder"]}
          size={font}
          color={colors.text}
        />
      )}
    </View>
  );
}

/**
 * Mobile ProjectIcon — RN port of
 * `packages/views/projects/components/project-icon.tsx`. Renders the
 * project's line icon key, falling back to the folder glyph for empty and
 * legacy free-text (emoji) values.
 *
 * `tile` sits beside a project title: the glyph on the neutral rounded
 * square used by agent avatars, matching web's `tile` size.
 */
import type { ComponentProps } from "react";
import { View } from "react-native";
import { MaterialCommunityIcons } from "@expo/vector-icons";
import { useColorScheme } from "nativewind";
import {
  DEFAULT_PROJECT_ICON,
  parseProjectIcon,
  type ProjectIconKey,
} from "@marvis/core/projects/config";
import { THEME } from "@/lib/theme";

export type ProjectIconSize = "sm" | "md" | "lg" | "tile";

type GlyphName = ComponentProps<typeof MaterialCommunityIcons>["name"];

const SIZE: Record<ProjectIconSize, { box: number; glyph: number }> = {
  sm: { box: 18, glyph: 14 },
  md: { box: 22, glyph: 16 },
  lg: { box: 28, glyph: 22 },
  tile: { box: 44, glyph: 22 },
};

// Closest outline equivalents of the web/desktop lucide glyphs.
export const PROJECT_ICON_GLYPHS: Record<ProjectIconKey, GlyphName> = {
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
  "git-branch": "source-branch",
  database: "database-outline",
  server: "server",
  cloud: "cloud-outline",
  smartphone: "cellphone",
  monitor: "monitor",
  palette: "palette-outline",
  "pen-tool": "fountain-pen-tip",
  "book-open": "book-open-outline",
  "file-text": "file-document-outline",
  megaphone: "bullhorn-outline",
  "chart-line": "chart-line",
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
  const { box, glyph } = SIZE[size];
  const { colorScheme } = useColorScheme();
  const theme = colorScheme === "dark" ? THEME.dark : THEME.light;
  const tile = size === "tile";

  return (
    <View
      style={{
        width: box,
        height: box,
        alignItems: "center",
        justifyContent: "center",
        borderRadius: tile ? box * 0.28 : 0,
        backgroundColor: tile ? theme.secondary : undefined,
      }}
    >
      <MaterialCommunityIcons
        name={PROJECT_ICON_GLYPHS[parseProjectIcon(icon) ?? DEFAULT_PROJECT_ICON]}
        size={glyph}
        color={theme.foreground}
      />
    </View>
  );
}

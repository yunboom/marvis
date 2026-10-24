/**
 * Inline icon chooser for the project create/edit forms. Mirrors web's
 * `ProjectIconPicker` grid (same keys, same order); the selected key is
 * filled with the foreground ink. Tapping the selected key again clears it.
 */
import { Pressable, View } from "react-native";
import { MaterialCommunityIcons } from "@expo/vector-icons";
import { useColorScheme } from "nativewind";
import { parseProjectIcon, PROJECT_ICONS } from "@marvis/core/projects/config";
import { PROJECT_ICON_GLYPHS } from "@/components/ui/project-icon";
import { THEME } from "@/lib/theme";
import { cn } from "@/lib/utils";

interface Props {
  value: string;
  onChange: (icon: string) => void;
}

export function ProjectIconGrid({ value, onChange }: Props) {
  const { colorScheme } = useColorScheme();
  const theme = colorScheme === "dark" ? THEME.dark : THEME.light;
  const current = parseProjectIcon(value);

  return (
    <View className="flex-row flex-wrap gap-1">
      {PROJECT_ICONS.map((key) => {
        const selected = current === key;
        return (
          <Pressable
            key={key}
            accessibilityRole="button"
            accessibilityLabel={key}
            accessibilityState={{ selected }}
            onPress={() => onChange(selected ? "" : key)}
            className={cn(
              "size-10 items-center justify-center rounded-lg",
              selected ? "bg-foreground" : "active:bg-secondary",
            )}
          >
            <MaterialCommunityIcons
              name={PROJECT_ICON_GLYPHS[key]}
              size={20}
              color={selected ? theme.background : theme.mutedForeground}
            />
          </Pressable>
        );
      })}
    </View>
  );
}

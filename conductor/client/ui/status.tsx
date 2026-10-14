import { Text, View } from "react-native";
import { Icon } from "@getpaseo/plugin/client/react-native";
import type { PluginTheme } from "@getpaseo/plugin";
import type { PluginIconProps } from "@getpaseo/plugin/client/react-native";
import type { AgentItem } from "../../shared/agents/models";
import type { StoredSymphony } from "../../shared/symphonies/models";
import { symphonyStatusLabel } from "../../shared/symphonies/models";
import type {
  TaskDisplayState,
  TaskStateKey,
} from "../../shared/symphonies/task-state";

/**
 * Semantic presentation of a status: which host Lucide icon to show, which
 * theme color role to use, and the visible label. The label always wins the
 * accessibility name; the icon is decorative (see {@link StatusMarker}).
 */
export interface StatusPresentation {
  label: string;
  icon: PluginIconProps["name"];
  color: StatusColor;
}

/**
 * A theme color role. The keys resolve one-to-one against
 * `PluginThemeColors`, so presentation only carries the role, never a
 * literal color value.
 */
export type StatusColor =
  | "foregroundMuted"
  | "accent"
  | "statusWarning"
  | "statusDanger"
  | "statusSuccess";

/** Resolve a status color role against the active theme. */
export function statusColor(theme: PluginTheme, color: StatusColor): string {
  return theme.colors[color];
}

/**
 * Task states present exactly the projection labels produced by
 * `taskState` in `shared/symphonies/task-state.ts`, never a stronger word
 * (a settling completed attempt stays "Finishing").
 */
const TASK_ICONS: Record<TaskStateKey, StatusPresentation["icon"]> = {
  ready: "Circle",
  waiting: "Clock3",
  running: "Activity",
  blocked: "CirclePause",
  finishing: "Hourglass",
  completed: "CircleCheck",
  "needs-changes": "RotateCcw",
  failed: "CircleX",
};

const TASK_COLORS: Record<TaskStateKey, StatusColor> = {
  ready: "foregroundMuted",
  waiting: "foregroundMuted",
  running: "accent",
  blocked: "statusWarning",
  finishing: "statusWarning",
  "needs-changes": "statusWarning",
  completed: "statusSuccess",
  failed: "statusDanger",
};

/** Presentation for a task display projection from `taskState`. */
export function taskStatusPresentation(
  state: TaskDisplayState,
): StatusPresentation {
  return {
    label: state.label,
    icon: TASK_ICONS[state.key],
    color: TASK_COLORS[state.key],
  };
}

/**
 * A completed symphony only ever reads "Complete" as claimed by
 * `symphonyStatusLabel`; an idle agent never borrows that treatment. The
 * labels stay the shared label authority's own words.
 */
const SYMPHONY_PRESENTATION: Record<
  StoredSymphony["status"],
  Omit<StatusPresentation, "label">
> = {
  planning: { icon: "Clock3", color: "foregroundMuted" },
  ready: { icon: "Circle", color: "foregroundMuted" },
  running: { icon: "Activity", color: "accent" },
  blocked: { icon: "CirclePause", color: "statusWarning" },
  completed: { icon: "CircleCheck", color: "statusSuccess" },
  failed: { icon: "CircleX", color: "statusDanger" },
};

/** Presentation for a symphony status; labels come from `symphonyStatusLabel`. */
export function symphonyStatusPresentation(
  status: StoredSymphony["status"],
): StatusPresentation {
  return {
    label: symphonyStatusLabel(status),
    ...SYMPHONY_PRESENTATION[status],
  };
}

/** Agent bucket presentation; closed and idle never read as Completed. */
const AGENT_BUCKET_PRESENTATION: Record<
  AgentItem["bucket"],
  Omit<StatusPresentation, "label">
> = {
  waiting: { icon: "Clock3", color: "statusWarning" },
  failed: { icon: "CircleX", color: "statusDanger" },
  running: { icon: "Activity", color: "accent" },
  closed: { icon: "Archive", color: "foregroundMuted" },
  idle: { icon: "Circle", color: "foregroundMuted" },
};

function capitalize(value: string): string {
  return value.charAt(0).toUpperCase() + value.slice(1);
}

/**
 * Presentation for a queued agent item. A marked reminder or an open request
 * outranks the bucket so the icon points at the action the user can take,
 * not just the agent's state.
 */
export function agentStatusPresentation(
  item: Pick<AgentItem, "bucket" | "requestId" | "marked">,
): StatusPresentation {
  if (item.marked) {
    return { label: "Manual reminder", icon: "Bell", color: "statusWarning" };
  }
  if (item.requestId) {
    return {
      label: "Needs answer",
      icon: "MessageCircle",
      color: "statusWarning",
    };
  }
  return {
    label: capitalize(item.bucket),
    ...AGENT_BUCKET_PRESENTATION[item.bucket],
  };
}

/**
 * A visible icon plus the presentation's label; the icon is hidden from
 * assistive technology so the text carries the accessible name.
 */
export function StatusMarker({
  theme,
  presentation,
  size = 16,
}: {
  theme: PluginTheme;
  presentation: StatusPresentation;
  size?: number;
}) {
  const color = statusColor(theme, presentation.color);
  return (
    <View style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
      <View
        aria-hidden
        accessible={false}
        accessibilityElementsHidden
        importantForAccessibility="no-hide-descendants"
      >
        <Icon name={presentation.icon} size={size} color={color} />
      </View>
      <Text
        style={{
          color,
          fontSize: 12,
          lineHeight: size,
          fontWeight: "500",
        }}
      >
        {presentation.label}
      </Text>
    </View>
  );
}

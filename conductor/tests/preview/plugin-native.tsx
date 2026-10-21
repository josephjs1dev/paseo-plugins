import { useEffect, type ReactNode } from "react";
import { createPortal } from "react-dom";
import {
  Pressable,
  Text,
  View,
  type PressableProps,
  type ViewStyle,
} from "react-native";
import type { PluginIconProps } from "@getpaseo/plugin/client";

/**
 * Element geometry for one Lucide icon, modeled on the upstream 0.468.0
 * sources so the preview renders real icon shapes, not placeholders.
 */
type LucideShape =
  | ["path", string]
  | ["circle", cx: number, cy: number, r: number]
  | ["line", x1: number, y1: number, x2: number, y2: number]
  | ["rect", x: number, y: number, width: number, height: number, rx: number]
  | ["polyline", string];

/** Geometry must stay in sync with the names the client actually renders. */
const LUCIDE_SHAPES = {
  // Navigation and detail tabs
  Users: [
    ["path", "M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"],
    ["circle", 9, 7, 4],
    ["path", "M22 21v-2a4 4 0 0 0-3-3.87"],
    ["path", "M16 3.13a4 4 0 0 1 0 7.75"],
  ],
  Music2: [
    ["circle", 8, 18, 4],
    ["path", "M12 18V2l7 4"],
  ],
  ListChecks: [
    ["path", "m3 17 2 2 4-4"],
    ["path", "m3 7 2 2 4-4"],
    ["path", "M13 6h8"],
    ["path", "M13 12h8"],
    ["path", "M13 18h8"],
  ],
  GitBranch: [
    ["line", 6, 3, 6, 15],
    ["circle", 18, 6, 3],
    ["circle", 6, 18, 3],
    ["path", "M18 9a9 9 0 0 1-9 9"],
  ],
  FileText: [
    ["path", "M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z"],
    ["path", "M14 2v4a2 2 0 0 0 2 2h4"],
    ["path", "M10 9H8"],
    ["path", "M16 13H8"],
    ["path", "M16 17H8"],
  ],
  History: [
    ["path", "M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"],
    ["path", "M3 3v5h5"],
    ["path", "M12 7v5l4 2"],
  ],
  Search: [
    ["circle", 11, 11, 8],
    ["path", "m21 21-4.3-4.3"],
  ],
  ArrowLeft: [
    ["path", "m12 19-7-7 7-7"],
    ["path", "M19 12H5"],
  ],
  ArrowUpRight: [
    ["path", "M7 7h10v10"],
    ["path", "M7 17 17 7"],
  ],
  MessageSquareText: [
    ["path", "M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"],
    ["path", "M13 8H7"],
    ["path", "M17 12H7"],
  ],
  // Task states
  Circle: [["circle", 12, 12, 10]],
  Clock3: [
    ["circle", 12, 12, 10],
    ["polyline", "12 6 12 12 16.5 12"],
  ],
  Activity: [
    [
      "path",
      "M22 12h-2.48a2 2 0 0 0-1.93 1.46l-2.35 8.36a.25.25 0 0 1-.48 0L9.24 2.18a.25.25 0 0 0-.48 0l-2.35 8.36A2 2 0 0 1 4.49 12H2",
    ],
  ],
  CirclePause: [
    ["circle", 12, 12, 10],
    ["line", 10, 15, 10, 9],
    ["line", 14, 15, 14, 9],
  ],
  Hourglass: [
    ["path", "M5 22h14"],
    ["path", "M5 2h14"],
    [
      "path",
      "M17 22v-4.172a2 2 0 0 0-.586-1.414L12 12l-4.414 4.414A2 2 0 0 0 7 17.828V22",
    ],
    [
      "path",
      "M7 2v4.172a2 2 0 0 0 .586 1.414L12 12l4.414-4.414A2 2 0 0 0 17 6.172V2",
    ],
  ],
  RotateCcw: [
    ["path", "M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"],
    ["path", "M3 3v5h5"],
  ],
  CircleX: [
    ["circle", 12, 12, 10],
    ["path", "m15 9-6 6"],
    ["path", "m9 9 6 6"],
  ],
  CircleCheck: [
    ["circle", 12, 12, 10],
    ["path", "m9 12 2 2 4-4"],
  ],
  // Controls
  RefreshCw: [
    ["path", "M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8"],
    ["path", "M21 3v5h-5"],
    ["path", "M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16"],
    ["path", "M8 16H3v5"],
  ],
  ChevronDown: [["path", "m6 9 6 6 6-6"]],
  ChevronUp: [["path", "m18 15-6-6-6 6"]],
  Check: [["path", "M20 6 9 17l-5-5"]],
  // Agent actions and buckets
  MessageCircle: [["path", "M7.9 20A9 9 0 1 0 4 16.1L2 22Z"]],
  Archive: [
    ["rect", 2, 3, 20, 5, 1],
    ["path", "M4 8v11a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8"],
    ["path", "M10 12h4"],
  ],
  Bell: [
    ["path", "M10.268 21a2 2 0 0 0 3.464 0"],
    [
      "path",
      "M3.262 15.326A1 1 0 0 0 4 17h16a1 1 0 0 0 .74-1.673C19.41 13.956 18 12.499 18 8A6 6 0 0 0 6 8c0 4.499-1.411 5.956-2.738 7.326",
    ],
  ],
  Download: [
    ["path", "M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"],
    ["polyline", "7 10 12 15 17 10"],
    ["line", 12, 15, 12, 3],
  ],
  SlidersHorizontal: [
    ["line", 4, 21, 4, 14],
    ["line", 4, 10, 4, 3],
    ["line", 12, 21, 12, 12],
    ["line", 12, 8, 12, 3],
    ["line", 20, 21, 20, 16],
    ["line", 20, 12, 20, 3],
    ["line", 1, 14, 7, 14],
    ["line", 9, 8, 15, 8],
    ["line", 17, 16, 23, 16],
  ],
  PenLine: [
    ["path", "M12 20h9"],
    [
      "path",
      "M16.376 3.622a1 1 0 0 1 3.002 3.002L7.368 18.635a2 2 0 0 1-.855.506l-2.872.838.838-2.872a2 2 0 0 1 .506-.854z",
    ],
  ],
  Upload: [
    ["path", "M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"],
    ["polyline", "17 8 12 3 7 8"],
    ["line", 12, 3, 12, 15],
  ],
  TriangleAlert: [
    [
      "path",
      "m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3",
    ],
    ["path", "M12 9v4"],
    ["path", "M12 17h.01"],
  ],
  Copy: [
    ["rect", 8, 8, 14, 14, 2],
    ["path", "M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2"],
  ],
  X: [
    ["path", "M18 6 6 18"],
    ["path", "m6 6 12 12"],
  ],
} satisfies Record<string, readonly LucideShape[]>;

type IconName = keyof typeof LUCIDE_SHAPES;

interface ModalProps {
  title: string;
  icon?: ReactNode;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  children: ReactNode;
}

interface ModalContentProps {
  children: ReactNode;
  style?: ViewStyle;
}

/**
 * Minimal host-Modal shim: a fixed overlay portal to the document body, with
 * a titled panel and the content body. The portal is not cosmetic: the
 * dialog opens inside the profiles list, whose cards sit in later stacking
 * contexts, so an in-place overlay would paint underneath them. Escaping
 * closes through the same onOpenChange the host gestures would use; the
 * dialog itself still owns its Cancel action.
 */
const OVERLAY_STYLE = {
  position: "fixed",
  left: 0,
  right: 0,
  top: 0,
  bottom: 0,
  zIndex: 40,
  backgroundColor: "rgba(0, 0, 0, 0.45)",
  alignItems: "center",
  justifyContent: "center",
  padding: 24,
} as unknown as ViewStyle;

export function Modal({ title, open, onOpenChange, children }: ModalProps) {
  useEffect(() => {
    if (!open) {
      return undefined;
    }
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === "Escape") {
        onOpenChange(false);
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open, onOpenChange]);
  if (!open) {
    return null;
  }
  // RN 0.72 prop unions predate the dialog role and aria-modal; RNW accepts
  // both at runtime.
  const panelProps = {
    accessibilityRole: "dialog",
    "aria-modal": true,
  } as unknown as PressableProps;
  return createPortal(
    <View testID="preview-modal-overlay" style={OVERLAY_STYLE}>
      <Pressable
        testID="preview-modal-panel"
        {...panelProps}
        style={{
          width: "100%",
          maxWidth: 560,
          maxHeight: "88%",
          overflow: "scroll",
          borderRadius: 12,
          backgroundColor: "#ffffff",
          shadowColor: "#000000",
          shadowOpacity: 0.25,
          shadowRadius: 16,
        }}
      >
        <View style={{ padding: 20, paddingBottom: 8 }}>
          <Text style={{ color: "#1F2A37", fontSize: 17, fontWeight: "600" }}>
            {title}
          </Text>
        </View>
        <ModalContent>{children}</ModalContent>
      </Pressable>
    </View>,
    document.body,
  );
}

function ModalContent({ children, style }: ModalContentProps) {
  return <View style={[{ padding: 20, gap: 14 }, style]}>{children}</View>;
}

Modal.Content = ModalContent;

/** Fixture equivalent of Paseo's host-provided Lucide icon; no host runtime in Vite. */
export function Icon({ name, size = 18, color }: PluginIconProps) {
  const shapes = LUCIDE_SHAPES[name as IconName];
  if (!shapes) {
    throw new Error(`Missing preview icon: ${name}`);
  }
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke={color}
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      {shapes.map((shape, index) => {
        switch (shape[0]) {
          case "path":
            return <path key={index} d={shape[1]} />;
          case "circle":
            return (
              <circle key={index} cx={shape[1]} cy={shape[2]} r={shape[3]} />
            );
          case "line":
            return (
              <line
                key={index}
                x1={shape[1]}
                y1={shape[2]}
                x2={shape[3]}
                y2={shape[4]}
              />
            );
          case "rect":
            return (
              <rect
                key={index}
                x={shape[1]}
                y={shape[2]}
                width={shape[3]}
                height={shape[4]}
                rx={shape[5]}
              />
            );
          case "polyline":
            return <polyline key={index} points={shape[1]} />;
        }
      })}
    </svg>
  );
}

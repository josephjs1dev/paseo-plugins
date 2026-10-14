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
} satisfies Record<string, readonly LucideShape[]>;

type IconName = keyof typeof LUCIDE_SHAPES;

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

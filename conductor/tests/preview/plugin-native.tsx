import type { PluginIconProps } from "@getpaseo/plugin/client";

/** Lucide path sets for the icons the conductor client renders in preview. */
const ICON_PATHS = {
  RefreshCw: [
    "M3 12a9 9 0 0 1 15.36-6.36L21 8",
    "M21 3v5h-5",
    "M21 12a9 9 0 0 1-15.36 6.36L3 16",
    "M3 21v-5h5",
  ],
  ChevronDown: ["m6 9 6 6 6-6"],
  ChevronUp: ["m18 15-6-6-6 6"],
  Check: ["M20 6 9 17l-5-5"],
} satisfies Record<string, readonly string[]>;

type IconName = keyof typeof ICON_PATHS;

/** Fixture equivalent of Paseo's host-provided Lucide icon; no host runtime in Vite. */
export function Icon({ name, size = 18, color }: PluginIconProps) {
  const paths = ICON_PATHS[name as IconName];
  if (!paths) {
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
      {paths.map((d) => (
        <path key={d} d={d} />
      ))}
    </svg>
  );
}

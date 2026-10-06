import type { PluginIconProps } from "@getpaseo/plugin/client";

/** Fixture equivalent of Paseo's host-provided Lucide icon; no host runtime in Vite. */
export function Icon({ name, size = 18, color }: PluginIconProps) {
  if (name !== "RefreshCw") {
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
      <path d="M3 12a9 9 0 0 1 15.36-6.36L21 8" />
      <path d="M21 3v5h-5" />
      <path d="M21 12a9 9 0 0 1-15.36 6.36L3 16" />
      <path d="M3 21v-5h5" />
    </svg>
  );
}

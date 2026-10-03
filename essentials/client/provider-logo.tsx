import type { ComponentType } from "react";
import { Icon } from "@getpaseo/plugin/client/react-native";
import { View } from "react-native";

import { providerDefinitions, type Provider } from "../shared/providers";

interface LogoProps {
  size: number;
  color: string;
  backgroundColor: string;
}

function OpenCodeLogo({ size, color, backgroundColor }: LogoProps) {
  // Native geometry matches the supplied mark without its checkerboard backdrop.
  return (
    <View style={{ width: size * 0.8, height: size, backgroundColor: color }}>
      <View
        style={{
          position: "absolute",
          left: size * 0.2,
          top: size * 0.2,
          width: size * 0.4,
          height: size * 0.6,
          backgroundColor,
        }}
      >
        <View
          style={{
            position: "absolute",
            bottom: 0,
            width: "100%",
            height: "66.67%",
            backgroundColor: color,
            opacity: 0.2,
          }}
        />
      </View>
    </View>
  );
}

const providerLogos: Partial<Record<Provider, ComponentType<LogoProps>>> = {
  "opencode-go": OpenCodeLogo,
};

export function ProviderLogo({
  provider,
  ...props
}: LogoProps & { provider: Provider }) {
  const Logo = providerLogos[provider];

  if (Logo) {
    return <Logo {...props} />;
  }

  return (
    <Icon
      name={providerDefinitions[provider].icon}
      size={props.size}
      color={props.color}
    />
  );
}

import type { ModelSelection, ProviderDriverKind } from "@t3tools/contracts";
import {
  buildTraitsTriggerDisplay,
  getPromptControlledTraits,
  REASONING_SELECT_DESCRIPTOR_IDS,
} from "@t3tools/client-runtime/model-traits";
import {
  getProviderOptionCurrentLabel,
  getProviderOptionCurrentValue,
} from "@t3tools/shared/model";
import { View } from "react-native";
import type { ModelOption } from "../lib/modelOptions";
import { resolveProviderOptionDescriptors } from "../lib/providerOptions";
import { SymbolView } from "./ui/AppSymbol";
import { ComposerInlineControl } from "./ComposerToolbar";
import { ProviderIcon, ProviderInstanceIcon } from "./ProviderIcon";

export function ComposerModelControl(props: {
  readonly modelOption: ModelOption | null;
  readonly selection: ModelSelection | null;
  readonly provider: ProviderDriverKind | undefined;
  readonly reportedSelection?: ModelSelection | null | undefined;
  readonly prompt: string;
  readonly surfaceColor: string;
  readonly disabled?: boolean;
  readonly size?: "regular" | "large";
  readonly iconOnly?: boolean;
  readonly onPress: () => void;
}) {
  const descriptors = resolveProviderOptionDescriptors({
    capabilities: props.modelOption?.capabilities,
    selections: props.selection?.options,
  });
  const promptTraits = getPromptControlledTraits(descriptors, props.prompt);
  const summary = props.provider
    ? buildTraitsTriggerDisplay({
        provider: props.provider,
        descriptors,
        primarySelectDescriptorId: promptTraits.primarySelectDescriptor?.id ?? null,
        ultrathinkPromptControlled: promptTraits.ultrathinkPromptControlled,
        modelSelection: props.selection,
        reportedModelSelection: props.reportedSelection,
      }).label
    : "";
  const badge = props.modelOption?.providerBadge;
  const label = props.modelOption?.label ?? props.selection?.model ?? "Choose model";
  const reasoningDescriptor = descriptors.find(
    (descriptor) =>
      descriptor.type === "select" && REASONING_SELECT_DESCRIPTOR_IDS.has(descriptor.id),
  );
  const reasoningLabel =
    reasoningDescriptor &&
    promptTraits.ultrathinkPromptControlled &&
    reasoningDescriptor.id === promptTraits.primarySelectDescriptor?.id
      ? "Ultrathink"
      : getProviderOptionCurrentLabel(
          reasoningDescriptor,
          props.selection,
          props.reportedSelection,
        );
  const serviceTier = descriptors.find((descriptor) => descriptor.id === "serviceTier");
  const fastMode = descriptors.find((descriptor) => descriptor.id === "fastMode");
  const speedLabel =
    props.provider === "codex" && serviceTier
      ? getProviderOptionCurrentLabel(serviceTier, props.selection, props.reportedSelection)
      : getProviderOptionCurrentValue(fastMode, props.selection, props.reportedSelection) === true
        ? "Fast"
        : undefined;
  const speedIconCount = speedLabel === "Ultrafast" ? 2 : speedLabel === "Fast" ? 1 : 0;
  return (
    <ComposerInlineControl
      accessibilityLabel={[
        "Model and reasoning settings",
        label,
        badge?.showBadge ? badge.displayName : null,
        summary,
      ]
        .filter(Boolean)
        .join(", ")}
      size={props.size}
      disabled={props.disabled}
      emphasized
      renderIcon={(size) =>
        badge?.showBadge ? (
          <ProviderInstanceIcon
            iconUrl={props.modelOption?.providerIconUrl}
            provider={props.modelOption?.providerDriver}
            displayName={badge.displayName}
            accentColor={badge.accentColor}
            showBadge
            surfaceColor={props.surfaceColor}
            size={size}
          />
        ) : (
          <ProviderIcon
            iconUrl={props.modelOption?.providerIconUrl}
            provider={props.modelOption?.providerDriver}
            size={size}
          />
        )
      }
      label={label}
      detail={reasoningLabel}
      iconOnly={props.iconOnly}
      suffix={
        speedIconCount > 0 ? (
          <View
            style={{
              width: (props.size === "large" ? 15 : 12) + (speedIconCount === 2 ? 5 : 0),
              height: 18,
            }}
            accessibilityElementsHidden
          >
            <SymbolView
              name={{ ios: "bolt.fill", android: "bolt" }}
              size={props.size === "large" ? 15 : 12}
              tintColorClassName="accent-icon-muted"
              type="monochrome"
              style={{ position: "absolute", left: 0, top: speedIconCount === 2 ? 3 : 1 }}
            />
            {speedIconCount === 2 ? (
              <SymbolView
                name={{ ios: "bolt.fill", android: "bolt" }}
                size={props.size === "large" ? 15 : 12}
                tintColorClassName="accent-icon-muted"
                type="monochrome"
                style={{ position: "absolute", left: 5, top: 0 }}
              />
            ) : null}
          </View>
        ) : undefined
      }
      maxWidth="100%"
      onPress={props.onPress}
    />
  );
}

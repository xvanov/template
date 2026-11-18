/**
 * The three non-data states every query-backed panel shows, so new screens
 * look and behave the same (the web app's components/ui/states.tsx, in
 * NativeWind). Render exactly one of Loading / Error / Empty / the data.
 */
import type { ReactNode } from "react";
import { ActivityIndicator, Pressable, Text, View } from "react-native";

import { useThemeColors } from "../lib/theme";

export function LoadingState({ label }: { label?: string }) {
  const colors = useThemeColors();
  return (
    <View className="items-center justify-center gap-2 py-10">
      <ActivityIndicator color={colors.muted} />
      {label ? <Text className="text-sm text-muted">{label}</Text> : null}
    </View>
  );
}

export function EmptyState({
  title,
  hint,
  action,
}: {
  title: string;
  hint?: string;
  action?: ReactNode;
}) {
  return (
    <View className="items-center justify-center gap-1 px-6 py-10">
      <Text className="text-base font-medium text-fg">{title}</Text>
      {hint ? (
        <Text className="text-center text-sm text-muted">{hint}</Text>
      ) : null}
      {action ? <View className="pt-3">{action}</View> : null}
    </View>
  );
}

export function ErrorState({
  message,
  onRetry,
}: {
  message: string;
  onRetry?: () => void;
}) {
  return (
    <View className="items-center justify-center gap-3 px-6 py-10">
      <Text className="text-center text-sm text-danger">{message}</Text>
      {onRetry ? (
        <Button variant="outline" onPress={onRetry}>
          Try again
        </Button>
      ) : null}
    </View>
  );
}

export function Button({
  children,
  onPress,
  disabled,
  variant = "primary",
  accessibilityLabel,
}: {
  children: ReactNode;
  onPress: () => void;
  disabled?: boolean;
  variant?: "primary" | "outline" | "danger";
  accessibilityLabel?: string;
}) {
  const box =
    variant === "primary"
      ? "bg-accent"
      : variant === "danger"
        ? "border border-danger"
        : "border border-border bg-surface";
  const text =
    variant === "primary"
      ? "text-accent-fg"
      : variant === "danger"
        ? "text-danger"
        : "text-fg";
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel}
      accessibilityState={{ disabled: Boolean(disabled) }}
      disabled={disabled}
      onPress={onPress}
      className={`items-center justify-center rounded-xl px-4 py-3 disabled:opacity-50 ${box}`}
    >
      {typeof children === "string" ? (
        <Text className={`font-medium ${text}`}>{children}</Text>
      ) : (
        children
      )}
    </Pressable>
  );
}

/** A thin progress bar, 0..1. */
export function ProgressBar({ value }: { value: number }) {
  const pct = Math.round(Math.max(0, Math.min(1, value)) * 100);
  return (
    <View
      accessibilityRole="progressbar"
      accessibilityValue={{ min: 0, max: 100, now: pct }}
      className="h-1.5 w-full overflow-hidden rounded-full bg-border"
    >
      <View className="h-full bg-accent" style={{ width: `${pct}%` }} />
    </View>
  );
}

/**
 * What this phone can do, for testing on a real device: push registration
 * (and a test push through the server's outbound guard), and the glasses
 * slot. Most of it says "needs a development build" in Expo Go, on purpose.
 */
import { router } from "expo-router";
import { Pressable, ScrollView, Text, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";

import { availability as glassesAvailability } from "../modules/glasses";
import { Button, ErrorState, LoadingState } from "../components/states";
import { pushSupport } from "../lib/push";
import { trpc } from "../lib/trpc";
import { usePushState } from "../lib/use-push";

function Row({ label, value }: { label: string; value: string }) {
  return (
    <View className="flex-row justify-between gap-4 border-b border-border py-3">
      <Text className="text-sm text-muted">{label}</Text>
      <Text className="flex-1 text-right text-sm text-fg">{value}</Text>
    </View>
  );
}

export default function Device() {
  const push = usePushState();
  const support = pushSupport();
  const server = trpc.push.status.useQuery();
  const devices = trpc.push.devices.useQuery();
  const test = trpc.push.test.useMutation();
  const glasses = glassesAvailability();

  const registration =
    push.status === "registered"
      ? "Registered"
      : push.status === "unavailable"
        ? push.reason
        : push.status === "error"
          ? `Failed: ${push.message}`
          : push.status === "registering"
            ? "Registering…"
            : support.ok
              ? "Not yet"
              : support.message;

  return (
    <SafeAreaView className="flex-1 bg-bg" edges={["top", "bottom"]}>
      <View className="flex-row items-center justify-between px-5 pt-2 pb-4">
        <Pressable
          accessibilityRole="button"
          onPress={() => router.back()}
          className="py-2 pr-3"
        >
          <Text className="text-sm text-accent">‹ Back</Text>
        </Pressable>
        <Text className="text-xl font-semibold text-fg">This device</Text>
        <View className="w-12" />
      </View>

      <ScrollView contentContainerClassName="px-5 pb-10">
        <Text className="pt-2 pb-1 text-xs font-semibold uppercase text-muted">
          Push notifications
        </Text>
        <Row
          label="Server"
          value={
            server.data
              ? server.data.enabled
                ? "On"
                : "Off (OUTBOUND_MOBILE_PUSH_ENABLED)"
              : "…"
          }
        />
        <Row label="This install" value={registration} />

        {devices.isPending ? (
          <LoadingState />
        ) : devices.error ? (
          <ErrorState
            message={devices.error.message}
            onRetry={() => void devices.refetch()}
          />
        ) : (
          devices.data.map((d) => (
            <Row
              key={d.id}
              label={`${d.platform} ${d.token}`}
              value={d.disabled ? `Disabled (${d.disabledReason})` : "Active"}
            />
          ))
        )}

        <View className="gap-2 pt-4">
          <Button
            variant="outline"
            disabled={!server.data?.enabled || test.isPending}
            onPress={() => test.mutate()}
          >
            Send a test push
          </Button>
          {test.data ? (
            <Text className="text-sm text-muted">
              {test.data.devices} device(s): {test.data.sent} sent,{" "}
              {test.data.blocked} blocked by the outbound guard
              {test.data.blocked
                ? " (safe mode: add your email to OUTBOUND_SAFE_RECIPIENTS)"
                : ""}
              .
            </Text>
          ) : null}
          {test.error ? (
            <Text className="text-sm text-danger">{test.error.message}</Text>
          ) : null}
        </View>

        <Text className="pt-8 pb-1 text-xs font-semibold uppercase text-muted">
          Smart glasses
        </Text>
        <Row
          label="Status"
          value={
            glasses.status === "available"
              ? "Available"
              : glasses.reason === "no_native_module"
                ? "Not in this build"
                : "Not supported here"
          }
        />
      </ScrollView>
    </SafeAreaView>
  );
}

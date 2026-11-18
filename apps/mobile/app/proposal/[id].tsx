/**
 * One agent proposal: what a "Waiting for your approval" push opens. Approve
 * or reject it here; the full review (editing the input) is on the web.
 */
import { useLocalSearchParams } from "expo-router";
import { ScrollView, Text, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";

import { ScreenHeader } from "../../components/screen-header";
import { Button, ErrorState, LoadingState } from "../../components/states";
import { useFormatDate } from "../../lib/format";
import { trpc } from "../../lib/trpc";

export default function Proposal() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const utils = trpc.useUtils();
  const proposal = trpc.agent.proposal.useQuery({ id });
  const done = () => void utils.agent.proposal.invalidate({ id });
  const approve = trpc.agent.approve.useMutation({ onSettled: done });
  const reject = trpc.agent.reject.useMutation({ onSettled: done });
  const formatDate = useFormatDate();
  const busy = approve.isPending || reject.isPending;
  const error = approve.error ?? reject.error;

  return (
    <SafeAreaView className="flex-1 bg-bg" edges={["top", "bottom"]}>
      <ScreenHeader title="Proposal" />
      {proposal.isPending ? (
        <LoadingState />
      ) : proposal.error ? (
        <ErrorState
          message={proposal.error.message}
          onRetry={() => void proposal.refetch()}
        />
      ) : (
        <ScrollView contentContainerClassName="gap-3 px-5 pb-10">
          <Text className="text-lg font-medium text-fg">
            {proposal.data.summary}
          </Text>
          {proposal.data.claim ? (
            <Text className="text-sm text-muted">
              The agent says (unverified): {proposal.data.claim}
            </Text>
          ) : null}
          <Text className="text-xs text-muted">
            {proposal.data.tool} · {formatDate(proposal.data.createdAt)} ·{" "}
            {proposal.data.status}
          </Text>
          {proposal.data.status === "pending" ? (
            <View className="flex-row gap-2 pt-2">
              <View className="flex-1">
                <Button disabled={busy} onPress={() => approve.mutate({ id })}>
                  Approve
                </Button>
              </View>
              <View className="flex-1">
                <Button
                  variant="danger"
                  disabled={busy}
                  onPress={() => reject.mutate({ id })}
                >
                  Reject
                </Button>
              </View>
            </View>
          ) : null}
          {error ? (
            <Text className="text-sm text-danger">{error.message}</Text>
          ) : null}
        </ScrollView>
      )}
    </SafeAreaView>
  );
}

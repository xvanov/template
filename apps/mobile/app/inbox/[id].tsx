/**
 * One inbound message (email or text): what a "New email" push opens.
 * Plain text only; the HTML view and attachments are on the web.
 */
import { useLocalSearchParams } from "expo-router";
import { ScrollView, Text } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";

import { ScreenHeader } from "../../components/screen-header";
import { Button, ErrorState, LoadingState } from "../../components/states";
import { useFormatDate } from "../../lib/format";
import { trpc } from "../../lib/trpc";

export default function InboxMessage() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const utils = trpc.useUtils();
  const message = trpc.inbox.get.useQuery({ id });
  const setHandled = trpc.inbox.setHandled.useMutation({
    onSettled: () => void utils.inbox.get.invalidate({ id }),
  });
  const formatDate = useFormatDate();

  return (
    <SafeAreaView className="flex-1 bg-bg" edges={["top", "bottom"]}>
      <ScreenHeader
        title={message.data?.channel === "sms" ? "Text message" : "Email"}
      />
      {message.isPending ? (
        <LoadingState />
      ) : message.error ? (
        <ErrorState
          message={message.error.message}
          onRetry={() => void message.refetch()}
        />
      ) : (
        <ScrollView contentContainerClassName="gap-3 px-5 pb-10">
          <Text className="text-lg font-medium text-fg">
            {message.data.subject ||
              (message.data.channel === "sms"
                ? "Text message"
                : "(no subject)")}
          </Text>
          <Text className="text-sm text-muted">
            From {message.data.fromAddress} ·{" "}
            {formatDate(message.data.createdAt)}
          </Text>
          <Text className="text-base text-fg">
            {message.data.text?.trim() || "(no text)"}
          </Text>
          <Button
            variant="outline"
            disabled={setHandled.isPending}
            onPress={() =>
              setHandled.mutate({ id, handled: !message.data.handledAt })
            }
          >
            {message.data.handledAt ? "Mark as not handled" : "Mark handled"}
          </Button>
          {setHandled.error ? (
            <Text className="text-sm text-danger">
              {setHandled.error.message}
            </Text>
          ) : null}
        </ScrollView>
      )}
    </SafeAreaView>
  );
}

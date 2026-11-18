import { useState } from "react";
import { router } from "expo-router";
import {
  FlatList,
  Pressable,
  RefreshControl,
  Text,
  TextInput,
  View,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";

import { DictateButton } from "../components/dictate-button";
import { EmptyState, ErrorState, LoadingState } from "../components/states";
import { useSession } from "../lib/auth";
import { useThemeColors } from "../lib/theme";
import { trpc } from "../lib/trpc";
import { useSignOut } from "../lib/use-push";

/** The same data as the web dashboard, over the same typed API. */
export default function Items() {
  const colors = useThemeColors();
  const { data: session } = useSession();
  const org = trpc.org.current.useQuery();
  const items = trpc.items.list.useQuery({ includeDone: true, limit: 50 });

  const refetch = () => void items.refetch();
  const create = trpc.items.create.useMutation({ onSuccess: refetch });
  const setDone = trpc.items.setDone.useMutation({ onSuccess: refetch });
  const remove = trpc.items.remove.useMutation({ onSuccess: refetch });

  const [title, setTitle] = useState("");
  const [dictateError, setDictateError] = useState<string | null>(null);
  const signOut = useSignOut();

  return (
    <SafeAreaView className="flex-1 bg-bg" edges={["top", "bottom"]}>
      <View className="flex-row items-center justify-between px-5 pt-2 pb-4">
        <View className="flex-1 pr-3">
          <Text className="text-xl font-semibold text-fg" numberOfLines={1}>
            {org.data?.organization?.name ?? "Workspace"}
          </Text>
          <Text className="text-xs text-muted" numberOfLines={1}>
            {session?.user.email}
          </Text>
        </View>
        <Pressable
          accessibilityRole="button"
          onPress={async () => {
            await signOut();
            router.replace("/login");
          }}
          className="rounded-lg border border-border bg-surface px-3 py-2"
        >
          <Text className="text-sm text-fg">Sign out</Text>
        </Pressable>
      </View>

      <View className="flex-row gap-4 px-5 pb-3">
        <Pressable
          accessibilityRole="link"
          onPress={() => router.push("/photos")}
        >
          <Text className="text-sm text-accent">Photos</Text>
        </Pressable>
        <Pressable
          accessibilityRole="link"
          onPress={() => router.push("/device")}
        >
          <Text className="text-sm text-accent">This device</Text>
        </Pressable>
        <Pressable
          accessibilityRole="link"
          onPress={() => router.push("/glasses")}
        >
          <Text className="text-sm text-accent">Glasses</Text>
        </Pressable>
      </View>

      <View className="flex-row gap-2 px-5 pb-3">
        <TextInput
          className="flex-1 rounded-xl border border-border bg-surface px-4 py-3 text-base text-fg"
          placeholder="Add an item…"
          placeholderTextColor={colors.muted}
          value={title}
          onChangeText={setTitle}
          onSubmitEditing={() => {
            const value = title.trim();
            if (!value) return;
            create.mutate({ title: value });
            setTitle("");
          }}
          returnKeyType="done"
        />
        <DictateButton
          onText={(text) => {
            setDictateError(null);
            // Into the field, not straight into the list: the user checks it.
            setTitle((t) => (t.trim() ? `${t.trim()} ${text}` : text));
          }}
          onError={setDictateError}
        />
        <Pressable
          accessibilityRole="button"
          disabled={!title.trim() || create.isPending}
          onPress={() => {
            const value = title.trim();
            if (!value) return;
            create.mutate({ title: value });
            setTitle("");
          }}
          className="justify-center rounded-xl bg-accent px-5 disabled:opacity-50"
        >
          <Text className="font-medium text-accent-fg">Add</Text>
        </Pressable>
      </View>

      {dictateError ? (
        <Text className="px-5 pb-2 text-sm text-danger">{dictateError}</Text>
      ) : null}

      {items.isPending ? (
        <LoadingState />
      ) : items.error && !items.data ? (
        <ErrorState message={items.error.message} onRetry={refetch} />
      ) : (
        <FlatList
          data={items.data ?? []}
          keyExtractor={(item) => item.id}
          contentContainerClassName="px-5 pb-8"
          refreshControl={
            <RefreshControl
              refreshing={items.isFetching}
              onRefresh={refetch}
              tintColor={colors.muted}
            />
          }
          ListEmptyComponent={
            <EmptyState
              title="Nothing yet"
              hint="Add one above, or dictate it."
            />
          }
          renderItem={({ item }) => (
            <View className="flex-row items-center gap-3 border-b border-border py-3">
              <Pressable
                accessibilityRole="checkbox"
                accessibilityState={{ checked: item.done }}
                onPress={() =>
                  setDone.mutate({ id: item.id, done: !item.done })
                }
                className="size-6 items-center justify-center rounded-md border border-border"
              >
                {item.done ? <Text className="text-accent">✓</Text> : null}
              </Pressable>
              <Text
                className={
                  item.done
                    ? "flex-1 text-base text-muted line-through"
                    : "flex-1 text-base text-fg"
                }
              >
                {item.title}
              </Text>
              <Pressable
                accessibilityRole="button"
                onPress={() => remove.mutate({ id: item.id })}
                className="px-2 py-1"
              >
                <Text className="text-sm text-danger">Delete</Text>
              </Pressable>
            </View>
          )}
        />
      )}
    </SafeAreaView>
  );
}

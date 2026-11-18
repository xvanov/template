import { router } from "expo-router";
import { Pressable, Text, View } from "react-native";

/** Back + title, for screens pushed on top of the items list. */
export function ScreenHeader({ title }: { title: string }) {
  return (
    <View className="flex-row items-center justify-between px-5 pt-2 pb-4">
      <Pressable
        accessibilityRole="button"
        onPress={() =>
          router.canGoBack() ? router.back() : router.replace("/items")
        }
        className="py-2 pr-3"
      >
        <Text className="text-sm text-accent">‹ Back</Text>
      </Pressable>
      <Text className="text-xl font-semibold text-fg" numberOfLines={1}>
        {title}
      </Text>
      <View className="w-12" />
    </View>
  );
}

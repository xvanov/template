import { Redirect } from "expo-router";
import { ActivityIndicator, View } from "react-native";

import { useSession } from "../lib/auth";

/** Session gate: the only job of the entry route. */
export default function Index() {
  const { data: session, isPending } = useSession();

  if (isPending) {
    return (
      <View className="flex-1 items-center justify-center bg-bg">
        <ActivityIndicator />
      </View>
    );
  }

  return <Redirect href={session?.user ? "/items" : "/login"} />;
}

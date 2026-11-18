/**
 * Take a photo or pick one, upload it to the workspace's media library
 * (POST /api/media/upload: the same allow-list and org scoping as the web
 * app), and show the library. Works in Expo Go.
 *
 * expo-image-picker, not expo-camera: one module gives both the system camera
 * and the library picker, with permissions, compression and HEIC→JPEG
 * conversion handled, and no camera UI to build or maintain. expo-camera is
 * for an in-app viewfinder (scanning, burst capture, skipping the
 * "Use photo" step); add it when a screen needs that.
 */
import { useState } from "react";
import * as ImagePicker from "expo-image-picker";
import { router } from "expo-router";
import { Image } from "expo-image";
import { FlatList, Pressable, Text, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";

import {
  Button,
  EmptyState,
  ErrorState,
  LoadingState,
  ProgressBar,
} from "../components/states";
import { mediaSource } from "../lib/media";
import { trpc } from "../lib/trpc";
import { uploadMedia, type LocalFile } from "../lib/upload";

/** Phones shoot 12+ MP; 0.7 keeps a photo well under the 25 MB upload cap. */
const PICK_OPTIONS: ImagePicker.ImagePickerOptions = {
  mediaTypes: ["images"],
  quality: 0.7,
  exif: false,
};

function toLocalFile(asset: ImagePicker.ImagePickerAsset): LocalFile {
  return { uri: asset.uri, name: asset.fileName, type: asset.mimeType };
}

export default function Photos() {
  const utils = trpc.useUtils();
  const media = trpc.media.list.useQuery({ limit: 60 });
  const [progress, setProgress] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function pick(source: "camera" | "library") {
    setError(null);
    if (source === "camera") {
      const perm = await ImagePicker.requestCameraPermissionsAsync();
      if (!perm.granted) {
        setError("Camera access is off for this app in Settings.");
        return;
      }
    }
    const result =
      source === "camera"
        ? await ImagePicker.launchCameraAsync(PICK_OPTIONS)
        : await ImagePicker.launchImageLibraryAsync(PICK_OPTIONS);
    const asset = result.canceled ? undefined : result.assets[0];
    if (!asset) return;

    setProgress(0);
    try {
      await uploadMedia(toLocalFile(asset), { onProgress: setProgress });
      await utils.media.list.invalidate();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setProgress(null);
    }
  }

  const run = (source: "camera" | "library") => () =>
    void pick(source).catch((err: unknown) =>
      setError(err instanceof Error ? err.message : String(err)),
    );
  const busy = progress !== null;
  const images = (media.data ?? []).filter((a) =>
    a.contentType.startsWith("image/"),
  );

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
        <Text className="text-xl font-semibold text-fg">Photos</Text>
        <View className="w-12" />
      </View>

      <View className="gap-3 px-5 pb-4">
        <View className="flex-row gap-2">
          <View className="flex-1">
            <Button disabled={busy} onPress={run("camera")}>
              Take photo
            </Button>
          </View>
          <View className="flex-1">
            <Button variant="outline" disabled={busy} onPress={run("library")}>
              Choose photo
            </Button>
          </View>
        </View>
        {busy ? (
          <View className="gap-1">
            <ProgressBar value={progress} />
            <Text className="text-xs text-muted">
              Uploading… {Math.round(progress * 100)}%
            </Text>
          </View>
        ) : null}
        {error ? <Text className="text-sm text-danger">{error}</Text> : null}
      </View>

      {media.isPending ? (
        <LoadingState />
      ) : media.error ? (
        <ErrorState
          message={media.error.message}
          onRetry={() => void media.refetch()}
        />
      ) : images.length === 0 ? (
        <EmptyState
          title="No photos yet"
          hint="Take one or choose one from your library."
        />
      ) : (
        <FlatList
          data={images}
          keyExtractor={(a) => a.id}
          numColumns={3}
          contentContainerClassName="px-4 pb-8"
          onRefresh={() => void media.refetch()}
          refreshing={media.isRefetching}
          renderItem={({ item }) => (
            <View className="aspect-square w-1/3 p-0.5">
              <View className="flex-1 overflow-hidden rounded-md bg-surface">
                {/* expo-image, not RN's Image: on Android (new architecture)
                    RN's Image drops `source.headers`, so the session cookie
                    never reaches /api/media/blob and every photo is a 401. */}
                <Image
                  source={mediaSource(item.url)}
                  accessibilityLabel={item.filename}
                  style={{ width: "100%", height: "100%" }}
                  contentFit="cover"
                  recyclingKey={item.id}
                />
              </View>
            </View>
          )}
        />
      )}
    </SafeAreaView>
  );
}

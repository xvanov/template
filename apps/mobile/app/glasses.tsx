/**
 * Glasses capture: photo from Meta glasses (or simulated glasses, or the
 * phone camera) → the media library → optional AI description → optionally
 * read aloud through the glasses' speakers. The flow is lib/glasses/pipeline.ts;
 * the sources are lib/glasses/sources.ts; the native side is modules/glasses.
 *
 * In Expo Go (no native module) only "Phone camera" is offered, and the rest
 * of the pipeline is the same, so the whole flow can be demoed without a dev
 * build or glasses.
 */
import { useEffect, useRef, useState } from "react";
import { Image } from "expo-image";
import { ScrollView, Switch, Text, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";

import { ScreenHeader } from "../components/screen-header";
import { Button, ProgressBar } from "../components/states";
import {
  captureAndDescribe,
  PipelineError,
  type PipelineStep,
} from "../lib/glasses/pipeline";
import {
  availableSources,
  photoSource,
  type PhotoSource,
  type SourceKind,
} from "../lib/glasses/sources";
import { discard, shrink } from "../lib/glasses/photo-files";
import { speak, stopSpeaking } from "../lib/glasses/speak";
import { mediaSource } from "../lib/media";
import { trpc } from "../lib/trpc";
import { uploadMedia } from "../lib/upload";
import * as Glasses from "../modules/glasses";

const SOURCE_LABEL: Record<SourceKind, string> = {
  glasses: "Glasses",
  simulated: "Simulated glasses",
  phone: "Phone camera",
};

const STEP_LABEL: Record<PipelineStep, string> = {
  capture: "Taking the photo…",
  upload: "Uploading…",
  describe: "Describing…",
  speak: "Reading it aloud…",
};

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export default function GlassesScreen() {
  const sources = availableSources();
  const [kind, setKind] = useState<SourceKind>(sources[0]!);
  const [status, setStatus] = useState(Glasses.getStatus());
  const [ready, setReady] = useState(false);
  const [step, setStep] = useState<PipelineStep | null>(null);
  const [progress, setProgress] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<{
    source: { uri: string; headers?: Record<string, string> };
    description: string | null;
  } | null>(null);
  const aiEnabled = trpc.ai.enabled.useQuery();
  const [describeOn, setDescribeOn] = useState(true);
  const [speakOn, setSpeakOn] = useState(true);
  const describe = trpc.ai.describeImage.useMutation();
  const utils = trpc.useUtils();
  const current = useRef<PhotoSource | null>(null);

  useEffect(() => {
    const subs = [
      Glasses.addStatusListener(setStatus),
      Glasses.addErrorListener((e) => setError(e.message)),
    ];
    return () => {
      subs.forEach((s) => s.remove());
      stopSpeaking();
      // Leaving the screen turns the camera (and its LED) off.
      void current.current?.release().catch(() => {});
    };
  }, []);

  async function switchTo(next: SourceKind) {
    if (next === kind) return;
    await current.current?.release().catch(() => {});
    current.current = null;
    setReady(false);
    setKind(next);
  }

  async function run() {
    setError(null);
    setResult(null);
    try {
      const source = current.current ?? photoSource(kind);
      if (!ready) {
        setStep("capture");
        await source.prepare();
        current.current = source;
        setReady(true);
      }
      const useAi = describeOn && aiEnabled.data?.enabled === true;
      const r = await captureAndDescribe(
        {
          capture: () => source.capture(),
          shrink,
          discard,
          upload: (file, onProgress) => uploadMedia(file, { onProgress }),
          ...(useAi
            ? {
                describe: (mediaId: string) =>
                  describe.mutateAsync({ mediaId }),
              }
            : {}),
          ...(useAi && speakOn ? { speak } : {}),
          onStep: (s, p) => {
            setStep(s);
            setProgress(s === "upload" ? (p ?? 0) : null);
          },
        },
        kind,
      );
      setResult({
        source: mediaSource(r.mediaUrl),
        description: r.description,
      });
      void utils.media.list.invalidate();
    } catch (err) {
      if (err instanceof PipelineError && err.partial.photo) {
        setResult({
          source: err.partial.mediaUrl
            ? mediaSource(err.partial.mediaUrl)
            : { uri: err.partial.photo.uri },
          description: err.partial.description ?? null,
        });
      }
      setError(errorText(err));
    } finally {
      setStep(null);
      setProgress(null);
    }
  }

  const busy = step !== null;
  const native = Glasses.availability();

  return (
    <SafeAreaView className="flex-1 bg-bg" edges={["top", "bottom"]}>
      <ScreenHeader title="Glasses" />
      <ScrollView contentContainerClassName="gap-4 px-5 pb-10">
        <View className="flex-row flex-wrap gap-2">
          {sources.map((s) => (
            <View key={s} className="min-w-[30%] flex-1">
              <Button
                variant={s === kind ? "primary" : "outline"}
                disabled={busy}
                onPress={() => void switchTo(s)}
              >
                {SOURCE_LABEL[s]}
              </Button>
            </View>
          ))}
        </View>

        <Text className="text-xs text-muted">
          {native.status === "available"
            ? status
              ? `Meta AI link: ${status.registration} · glasses: ${status.deviceCount} · camera: ${status.stream}${status.mockDevice ? " · simulated" : ""}`
              : "Glasses SDK ready."
            : "This build has no glasses SDK (GLASSES_ENABLED), so the phone camera stands in for the glasses."}
        </Text>

        <View className="gap-3 rounded-xl border border-border bg-surface p-4">
          <View className="flex-row items-center justify-between">
            <Text className="text-sm text-fg">Describe with AI</Text>
            <Switch
              value={describeOn && aiEnabled.data?.enabled === true}
              disabled={aiEnabled.data?.enabled !== true}
              onValueChange={setDescribeOn}
            />
          </View>
          <View className="flex-row items-center justify-between">
            <Text className="text-sm text-fg">Read it aloud</Text>
            <Switch
              value={speakOn}
              disabled={!describeOn || aiEnabled.data?.enabled !== true}
              onValueChange={setSpeakOn}
            />
          </View>
          {aiEnabled.data?.enabled === false ? (
            <Text className="text-xs text-muted">
              AI is off on this server, so photos are only uploaded.
            </Text>
          ) : null}
        </View>

        <Button disabled={busy} onPress={() => void run()}>
          {busy ? (step ? STEP_LABEL[step] : "Working…") : "Capture"}
        </Button>
        {progress !== null ? <ProgressBar value={progress} /> : null}
        {ready && kind !== "phone" ? (
          <Button
            variant="outline"
            disabled={busy}
            onPress={() => {
              void current.current?.release().catch(() => {});
              current.current = null;
              setReady(false);
            }}
          >
            Disconnect (camera off)
          </Button>
        ) : null}

        {error ? <Text className="text-sm text-danger">{error}</Text> : null}

        {result ? (
          <View className="gap-2">
            <View className="aspect-[4/3] overflow-hidden rounded-xl bg-surface">
              <Image
                source={result.source}
                style={{ width: "100%", height: "100%" }}
                contentFit="cover"
                accessibilityLabel="The captured photo"
              />
            </View>
            {result.description ? (
              <>
                <Text className="text-base text-fg">{result.description}</Text>
                <Button
                  variant="outline"
                  onPress={() => void speak(result.description!)}
                >
                  Read again
                </Button>
              </>
            ) : null}
          </View>
        ) : null}

        <Text className="text-xs text-muted">
          The glasses light their capture LED while the camera is on. Ask before
          photographing people; descriptions never identify anyone.
        </Text>
      </ScrollView>
    </SafeAreaView>
  );
}

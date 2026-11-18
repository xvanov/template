/**
 * Hold a thought, get text: record with expo-audio, transcribe on the server
 * (POST /api/media/transcribe → packages/ai transcribe()), hand the text to
 * `onText`. Works in Expo Go. Renders nothing when the server has no
 * transcription model configured (ai.transcribeEnabled).
 */
import { useState } from "react";
import {
  AudioQuality,
  IOSOutputFormat,
  RecordingPresets,
  requestRecordingPermissionsAsync,
  setAudioModeAsync,
  useAudioRecorder,
  useAudioRecorderState,
  type RecordingOptions,
} from "expo-audio";
import { ActivityIndicator, Platform, Pressable, Text } from "react-native";

import { useThemeColors } from "../lib/theme";
import { trpc } from "../lib/trpc";
import { transcribeAudio } from "../lib/upload";

/**
 * Speech, not music: 16 kHz mono AAC at 32 kbit/s is what speech-to-text
 * models resample to anyway, and a quarter of the HIGH_QUALITY preset's
 * size (~240 KB a minute), so uploads are quick on a phone network.
 */
const DICTATION: RecordingOptions = {
  ...RecordingPresets.HIGH_QUALITY,
  sampleRate: 16_000,
  numberOfChannels: 1,
  bitRate: 32_000,
  ios: {
    ...RecordingPresets.HIGH_QUALITY.ios,
    outputFormat: IOSOutputFormat.MPEG4AAC,
    audioQuality: AudioQuality.MEDIUM,
  },
  web: { mimeType: "audio/webm", bitsPerSecond: 32_000 },
};

/** A dictated item is a sentence or two; this bounds cost and upload size. */
const MAX_SECONDS = 120;

export function DictateButton({
  onText,
  onError,
}: {
  onText: (text: string) => void;
  onError: (message: string) => void;
}) {
  const colors = useThemeColors();
  const available = trpc.ai.transcribeEnabled.useQuery(undefined, {
    staleTime: 5 * 60_000,
  });
  const recorder = useAudioRecorder(DICTATION);
  const recorderState = useAudioRecorderState(recorder, 250);
  const [busy, setBusy] = useState(false);

  if (!available.data?.enabled) return null;

  async function start() {
    const perm = await requestRecordingPermissionsAsync();
    if (!perm.granted) {
      onError("Microphone access is off for this app in Settings.");
      return;
    }
    await setAudioModeAsync({ allowsRecording: true, playsInSilentMode: true });
    await recorder.prepareToRecordAsync();
    recorder.record({ forDuration: MAX_SECONDS });
  }

  async function stop() {
    setBusy(true);
    try {
      await recorder.stop();
      await setAudioModeAsync({ allowsRecording: false });
      const uri = recorder.uri;
      if (!uri) throw new Error("Nothing was recorded.");
      const { text } = await transcribeAudio({
        uri,
        name: Platform.OS === "web" ? "dictation.webm" : "dictation.m4a",
        type: Platform.OS === "web" ? "audio/webm" : "audio/mp4",
      });
      if (text) onText(text);
      else onError("No speech was recognised.");
    } catch (err) {
      onError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  const recording = recorderState.isRecording;
  const seconds = Math.floor(recorderState.durationMillis / 1000);
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={recording ? "Stop dictation" : "Dictate an item"}
      disabled={busy}
      onPress={() =>
        void (recording ? stop() : start()).catch((err: unknown) =>
          onError(err instanceof Error ? err.message : String(err)),
        )
      }
      className={`justify-center rounded-xl px-4 disabled:opacity-50 ${
        recording ? "bg-danger" : "border border-border bg-surface"
      }`}
    >
      {busy ? (
        <ActivityIndicator color={colors.muted} />
      ) : (
        <Text className={recording ? "font-medium text-white" : "text-fg"}>
          {recording ? `Stop ${seconds}s` : "Dictate"}
        </Text>
      )}
    </Pressable>
  );
}

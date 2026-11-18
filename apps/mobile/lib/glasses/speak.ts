/**
 * Speak a short text. With the glasses connected as the phone's Bluetooth
 * audio output (A2DP), the system routes this to their open-ear speakers;
 * no Meta SDK is involved. Resolves when speech ends (or fails: speaking is
 * a nicety, never a reason to lose the result).
 */
import * as Speech from "expo-speech";

export function speak(text: string): Promise<void> {
  return new Promise((resolve) => {
    Speech.stop();
    Speech.speak(text, {
      rate: 1.0,
      onDone: () => resolve(),
      onStopped: () => resolve(),
      onError: () => resolve(),
    });
  });
}

export function stopSpeaking(): void {
  Speech.stop();
}

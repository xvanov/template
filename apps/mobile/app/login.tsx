import { useState } from "react";
import { router } from "expo-router";
import {
  ActivityIndicator,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  ScrollView,
  Text,
  TextInput,
  View,
} from "react-native";

import { getBaseUrl } from "../lib/api-url";
import { authClient } from "../lib/auth";

export default function Login() {
  const [mode, setMode] = useState<"signin" | "signup">("signin");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit() {
    setError(null);
    setBusy(true);
    try {
      const result =
        mode === "signin"
          ? await authClient.signIn.email({ email, password })
          : await authClient.signUp.email({ email, password, name: email });

      if (result.error) {
        setError(result.error.message ?? "Could not sign in.");
        return;
      }
      router.replace("/items");
    } catch (err) {
      // The overwhelmingly common cause on a phone is an unreachable API host,
      // so say which host was tried instead of "Network request failed".
      setError(
        err instanceof Error
          ? `${err.message} (API: ${getBaseUrl()})`
          : `Could not reach ${getBaseUrl()}`,
      );
    } finally {
      setBusy(false);
    }
  }

  async function google() {
    setError(null);
    setBusy(true);
    try {
      // Opens the system browser and deep-links back on the app.json scheme.
      await authClient.signIn.social({
        provider: "google",
        callbackURL: "/items",
      });
      router.replace("/items");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Google sign-in failed.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <KeyboardAvoidingView
      className="flex-1 bg-bg"
      behavior={Platform.OS === "ios" ? "padding" : undefined}
    >
      <ScrollView contentContainerClassName="flex-1 justify-center px-6 py-12">
        <Text className="text-3xl font-semibold text-fg">
          {mode === "signin" ? "Sign in" : "Create account"}
        </Text>
        <Text className="mt-1 text-sm text-muted">
          Same account as the web app · {getBaseUrl()}
        </Text>

        <View className="mt-8 gap-3">
          <TextInput
            className="rounded-xl border border-border bg-surface px-4 py-3 text-base text-fg"
            placeholder="you@example.com"
            placeholderTextColor="#9ca3af"
            autoCapitalize="none"
            autoComplete="email"
            keyboardType="email-address"
            value={email}
            onChangeText={setEmail}
          />
          <TextInput
            className="rounded-xl border border-border bg-surface px-4 py-3 text-base text-fg"
            placeholder="password (8+ characters)"
            placeholderTextColor="#9ca3af"
            autoCapitalize="none"
            secureTextEntry
            value={password}
            onChangeText={setPassword}
          />

          {error ? <Text className="text-sm text-danger">{error}</Text> : null}

          <Pressable
            accessibilityRole="button"
            disabled={busy || !email || password.length < 8}
            onPress={submit}
            className="mt-1 flex-row items-center justify-center rounded-xl bg-accent px-4 py-3.5 disabled:opacity-50"
          >
            {busy ? (
              <ActivityIndicator color="#fff" />
            ) : (
              <Text className="font-medium text-accent-fg">
                {mode === "signin" ? "Sign in" : "Create account"}
              </Text>
            )}
          </Pressable>

          <Pressable
            accessibilityRole="button"
            disabled={busy}
            onPress={google}
            className="flex-row items-center justify-center rounded-xl border border-border bg-surface px-4 py-3.5"
          >
            <Text className="font-medium text-fg">Continue with Google</Text>
          </Pressable>

          <Pressable
            accessibilityRole="button"
            onPress={() => {
              setMode(mode === "signin" ? "signup" : "signin");
              setError(null);
            }}
            className="items-center pt-2"
          >
            <Text className="text-sm text-accent">
              {mode === "signin"
                ? "No account? Create one"
                : "Have an account? Sign in"}
            </Text>
          </Pressable>
        </View>
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

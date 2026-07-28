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
import { useThemeColors } from "../lib/theme";

export default function Login() {
  const colors = useThemeColors();
  const [mode, setMode] = useState<"signin" | "signup">("signin");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [sentTo, setSentTo] = useState<string | null>(null);

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

      // With verification required, sign-up returns no session: the account is
      // not usable until the emailed link is opened. Navigating to /items would
      // bounce straight back here.
      const token = (result.data as { token?: string | null } | null)?.token;
      if (mode === "signup" && !token) {
        setSentTo(email);
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

  // Post-sign-up: the account exists but needs its address confirmed first.
  if (sentTo) {
    return (
      <View className="flex-1 justify-center bg-bg px-6">
        <Text className="text-3xl font-semibold text-fg">
          Confirm your email
        </Text>
        <Text className="mt-3 text-base text-muted">
          We sent a confirmation link to {sentTo}. Open it on this phone to
          finish setting up your account, then come back and sign in.
        </Text>
        {error ? (
          <Text className="mt-3 text-sm text-danger">{error}</Text>
        ) : null}
        <Pressable
          accessibilityRole="button"
          disabled={busy}
          onPress={async () => {
            setError(null);
            setBusy(true);
            try {
              await authClient.sendVerificationEmail({ email: sentTo });
            } catch (err) {
              setError(
                err instanceof Error ? err.message : "Could not resend.",
              );
            } finally {
              setBusy(false);
            }
          }}
          className="mt-6 flex-row items-center justify-center rounded-xl border border-border bg-surface px-4 py-3.5"
        >
          <Text className="font-medium text-fg">
            {busy ? "Sending…" : "Resend link"}
          </Text>
        </Pressable>
        <Pressable
          accessibilityRole="button"
          onPress={() => {
            setSentTo(null);
            setMode("signin");
          }}
          className="items-center pt-4"
        >
          <Text className="text-sm text-accent">Back to sign in</Text>
        </Pressable>
      </View>
    );
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
            placeholderTextColor={colors.muted}
            autoCapitalize="none"
            autoComplete="email"
            keyboardType="email-address"
            value={email}
            onChangeText={setEmail}
          />
          <TextInput
            className="rounded-xl border border-border bg-surface px-4 py-3 text-base text-fg"
            placeholder="password (8+ characters)"
            placeholderTextColor={colors.muted}
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
              <ActivityIndicator color={colors.accentFg} />
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

/**
 * Deep links before the router sees them. The Meta AI app returns to this
 * app on its scheme with `?metaWearablesAction=…` after registration and
 * permission prompts. On iOS the glasses module claims those URLs itself
 * (GlassesAppDelegateSubscriber); on Android they also reach the router, and
 * would otherwise land on "/" — send them back to the glasses screen.
 */
export function redirectSystemPath({
  path,
}: {
  path: string;
  initial: boolean;
}) {
  return path.includes("metaWearablesAction") ? "/glasses" : path;
}

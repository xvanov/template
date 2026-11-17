import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

/**
 * Join class names and let later Tailwind utilities win over earlier ones
 * (`cn("px-2", "px-4")` → `"px-4"`). Every kit component takes `className`
 * and runs it through this, so callers can override without `!important`.
 */
export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

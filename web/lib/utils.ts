import { type ClassValue, clsx } from "clsx"
import { twMerge } from "tailwind-merge"

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}

/** Human-readable size for package bytes on the install page. */
export const kb = (bytes: number) => `${(bytes / 1024).toFixed(1)} KB`

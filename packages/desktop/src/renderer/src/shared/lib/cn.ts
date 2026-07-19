import { type ClassValue, clsx } from "clsx";
import { twMerge } from "tailwind-merge";

/** 合并 shadcn 组件 className。 */
export function cn(...values: ClassValue[]): string {
  return twMerge(clsx(values));
}

import { clsx, type ClassValue } from 'clsx'
import { twMerge } from 'tailwind-merge'

// Слияние Tailwind-классов с разрешением конфликтов — стандартный хелпер shadcn.
export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}

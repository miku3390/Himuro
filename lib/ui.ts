/** 共享 Tailwind 类名常量（保持全站观感一致，改这里即可换肤） */

export const card =
  "rounded-2xl border border-zinc-200 bg-white shadow-sm";

export const btnPrimary =
  "inline-flex items-center justify-center gap-1.5 whitespace-nowrap rounded-xl bg-indigo-600 px-4 py-2 text-sm font-medium text-white transition hover:bg-indigo-500 disabled:cursor-not-allowed disabled:opacity-50";

export const btnGhost =
  "inline-flex items-center justify-center gap-1.5 whitespace-nowrap rounded-xl border border-zinc-200 bg-white px-3 py-1.5 text-sm text-zinc-600 transition hover:border-zinc-300 hover:text-zinc-900 disabled:cursor-not-allowed disabled:opacity-50";

export const btnDanger =
  "inline-flex items-center justify-center gap-1.5 rounded-xl border border-red-200 bg-white px-3 py-1.5 text-sm text-red-500 transition hover:bg-red-50 disabled:cursor-not-allowed disabled:opacity-50";

export const input =
  "w-full rounded-xl border border-zinc-200 bg-white px-3 py-2 text-sm outline-none transition focus:border-indigo-400 focus:ring-2 focus:ring-indigo-100";

export const label = "mb-1 block text-xs font-medium text-zinc-500";

export const badge =
  "inline-flex items-center rounded-full px-2 py-0.5 text-[11px] font-medium";

export const textarea = input + " min-h-24 resize-y leading-relaxed";

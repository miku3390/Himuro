import type { Metadata } from "next";
import Link from "next/link";
import "./globals.css";

export const metadata: Metadata = {
  title: "Himuro 冰室",
  description: "本地自托管 AI 角色扮演 / 陪伴创作平台（风月复刻版）",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="zh-CN" className="h-full antialiased">
      <body className="min-h-full flex flex-col bg-zinc-100 text-zinc-900">
        <header className="sticky top-0 z-40 border-b border-zinc-200 bg-white/90 backdrop-blur">
          <div className="mx-auto flex h-14 w-full max-w-6xl items-center gap-6 px-4">
            <Link href="/" className="flex items-center gap-2 text-base font-bold tracking-wide">
              <span aria-hidden>❄</span>
              <span>
                Himuro<span className="ml-1 text-sm font-normal text-zinc-500">冰室</span>
              </span>
            </Link>
            <nav className="flex items-center gap-1 text-sm">
              <Link
                href="/"
                className="rounded-lg px-3 py-1.5 text-zinc-600 transition hover:bg-zinc-100 hover:text-zinc-900"
              >
                会话
              </Link>
              <Link
                href="/characters"
                className="rounded-lg px-3 py-1.5 text-zinc-600 transition hover:bg-zinc-100 hover:text-zinc-900"
              >
                角色
              </Link>
              <Link
                href="/settings"
                className="rounded-lg px-3 py-1.5 text-zinc-600 transition hover:bg-zinc-100 hover:text-zinc-900"
              >
                设置
              </Link>
            </nav>
            <div className="ml-auto text-xs text-zinc-400">本地自托管 · 数据不出本机</div>
          </div>
        </header>
        <main className="mx-auto flex w-full max-w-6xl flex-1 flex-col px-4 py-6">{children}</main>
      </body>
    </html>
  );
}

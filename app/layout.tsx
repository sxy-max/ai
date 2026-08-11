import "./globals.css";

export const metadata = {
  title: "Go AI",
  description: "A lightweight OpenCode Go client with optional Anthropic Claude support"
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return <html lang="zh-CN"><body>{children}</body></html>;
}

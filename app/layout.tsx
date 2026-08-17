import "./globals.css";

export const metadata = {
  title: "Go AI",
  description: "A lightweight OpenCode Go client with optional Anthropic Claude support"
};

// Mobile：viewport-fit=cover（safe-area 由 CSS env() 消费），themeColor 跟随品牌背景
export const viewport = {
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
  themeColor: "#0b0d11",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return <html lang="zh-CN"><body>{children}</body></html>;
}

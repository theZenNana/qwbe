import type { ReactNode } from "react"
import "./style.css"
import "./globals.css"

export const metadata = {
  title: "Qwbe",
  description: "Screens drawn from API metadata — no code written per cube",
}

export default function Layout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  )
}

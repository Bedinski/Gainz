import type { ReactNode } from 'react';
import './globals.css';

export const metadata = {
  title: 'Gainz',
  description: 'AI-driven stock trading',
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>
        <div className="container">{children}</div>
      </body>
    </html>
  );
}

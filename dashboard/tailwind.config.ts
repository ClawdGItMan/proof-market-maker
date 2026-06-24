import type { Config } from "tailwindcss";

const config: Config = {
  content: ["./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      fontFamily: {
        mono: ["ui-monospace", "SFMono-Regular", "Menlo", "monospace"],
      },
      colors: {
        ink: "#0a0e14",
        panel: "#11161f",
        edge: "#1e2733",
        muted: "#7d8a9c",
        run: "#3fb950",
        soft: "#d29922",
        hard: "#f85149",
      },
    },
  },
  plugins: [],
};

export default config;
